# Downloads the tools Rewind bundles into vendor\:
#  - the LGPL shared FFmpeg build (with NVENC) into vendor\ffmpeg
#  - Intel PresentMon 2.6.0 (MIT, used by the Performance test) into vendor\presentmon
# Run once after cloning:  powershell -ExecutionPolicy Bypass -File scripts\get-ffmpeg.ps1
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$root = Split-Path $PSScriptRoot -Parent
$vendor = Join-Path $root "vendor"

$target = Join-Path $vendor "ffmpeg"
if (Test-Path (Join-Path $target "bin\ffmpeg.exe")) {
    Write-Host "FFmpeg already in $target"
} else {
    $dl = Join-Path $vendor "ffmpeg-dl"
    New-Item -ItemType Directory -Force $dl | Out-Null
    $url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl-shared.zip"
    Write-Host "Downloading $url"
    Invoke-WebRequest -Uri $url -OutFile (Join-Path $dl "ffmpeg.zip")
    Expand-Archive (Join-Path $dl "ffmpeg.zip") -DestinationPath $dl -Force
    $inner = Get-ChildItem $dl -Directory | Select-Object -First 1
    Move-Item $inner.FullName $target
    Remove-Item -Recurse -Force $dl
    Write-Host "FFmpeg ready in $target"
}

$pm = Join-Path $vendor "presentmon"
if (Test-Path (Join-Path $pm "PresentMon.exe")) {
    Write-Host "PresentMon already in $pm"
} else {
    New-Item -ItemType Directory -Force $pm | Out-Null
    $url = "https://github.com/GameTechDev/PresentMon/releases/download/v2.6.0/PresentMon-2.6.0-x64.exe"
    Write-Host "Downloading $url"
    Invoke-WebRequest -Uri $url -OutFile (Join-Path $pm "PresentMon.exe")
    Invoke-WebRequest -Uri "https://raw.githubusercontent.com/GameTechDev/PresentMon/v2.6.0/LICENSE.txt" -OutFile (Join-Path $pm "LICENSE.txt")
    Write-Host "PresentMon ready in $pm"
}
