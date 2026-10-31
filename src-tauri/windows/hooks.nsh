; Runs inside Rewind's installer (also during auto-updates).

!macro NSIS_HOOK_PREINSTALL
  ; Stop Rewind's helper tools still running from this folder (for example an
  ; ffmpeg left behind by a crash), or their files can't be replaced and the
  ; update fails halfway. Clips cut off this way are finished on next start.
  nsExec::Exec `powershell -NoProfile -NonInteractive -Command "Get-Process ffmpeg,ffprobe,PresentMon -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like '$INSTDIR\*' } | Stop-Process -Force"`
  Pop $0
!macroend
