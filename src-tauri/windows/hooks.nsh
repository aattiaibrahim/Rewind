; Runs inside Rewind's installer (also during auto-updates).

!macro NSIS_HOOK_PREINSTALL
  ; Stop Rewind's helper tools still running from this folder (for example an
  ; ffmpeg left behind by a crash), or their files can't be replaced and the
  ; update fails halfway. Clips cut off this way are finished on next start.
  nsExec::Exec `powershell -NoProfile -NonInteractive -Command "Get-Process ffmpeg,ffprobe,PresentMon -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like '$INSTDIR\*' } | Stop-Process -Force"`
  Pop $0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Windows keeps old shortcut icons in its icon cache: refresh it so the new
  ; logo shows in the Start menu and taskbar without signing out.
  nsExec::Exec `"$SYSDIR\ie4uinit.exe" -show`
  Pop $0
!macroend
