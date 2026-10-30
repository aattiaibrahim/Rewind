# Packs the Stream Deck plugin into Rewind.streamDeckPlugin (double-click to install).
#   powershell -ExecutionPolicy Bypass -File scripts\package-streamdeck.ps1
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$root = Split-Path $PSScriptRoot -Parent
$name = "com.rewind.clipper.sdPlugin"
$src = Join-Path $root "streamdeck\$name"
$outDir = Join-Path $root "streamdeck\dist"
New-Item -ItemType Directory -Force $outDir | Out-Null
$out = Join-Path $outDir "Rewind.streamDeckPlugin"
if (Test-Path $out) { Remove-Item $out -Force }

# Zip entries must use forward slashes, which Compress-Archive on PowerShell 5 doesn't do.
$zip = [IO.Compression.ZipFile]::Open($out, 'Create')
try {
    Get-ChildItem $src -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($src.Length + 1).Replace('\', '/')
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, "$name/$rel") | Out-Null
    }
} finally { $zip.Dispose() }
Write-Host "Packed $out ($([math]::Round((Get-Item $out).Length / 1KB)) KB)"
