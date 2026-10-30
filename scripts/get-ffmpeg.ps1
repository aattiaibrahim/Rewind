# Downloads the LGPL shared FFmpeg build (with NVENC) into vendor/ffmpeg.
# Run once after cloning:  powershell -ExecutionPolicy Bypass -File scripts\get-ffmpeg.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$vendor = Join-Path $root "vendor"
$target = Join-Path $vendor "ffmpeg"
if (Test-Path (Join-Path $target "bin\ffmpeg.exe")) { Write-Host "FFmpeg already in $target"; exit 0 }

$dl = Join-Path $vendor "ffmpeg-dl"
New-Item -ItemType Directory -Force $dl | Out-Null
$url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl-shared.zip"
Write-Host "Downloading $url"
$ProgressPreference = "SilentlyContinue"
Invoke-WebRequest -Uri $url -OutFile (Join-Path $dl "ffmpeg.zip")
Expand-Archive (Join-Path $dl "ffmpeg.zip") -DestinationPath $dl -Force
$inner = Get-ChildItem $dl -Directory | Select-Object -First 1
Move-Item $inner.FullName $target
Remove-Item -Recurse -Force $dl
Write-Host "FFmpeg ready in $target"
