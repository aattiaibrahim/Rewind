# Builds a signed installer and publishes it as a GitHub release that
# existing installs will auto-update to.
#
#   1. Bump the version in src-tauri/tauri.conf.json (and Cargo.toml / package.json).
#   2. powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -Notes "What changed"
#
# Needs: the private signing key at $env:USERPROFILE\.tauri\rewind-updater.key
# (never commit it; keep a backup, or existing installs can't be updated), and gh logged in.
param(
    [string]$Notes = "Bug fixes and improvements.",
    [string]$KeyPath = "$env:USERPROFILE\.tauri\rewind-updater.key"
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$conf = Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
$version = $conf.version
$tag = "v$version"
$repo = "aattiaibrahim/Rewind"
if (-not (Test-Path $KeyPath)) { throw "Signing key not found at $KeyPath" }
$ErrorActionPreference = "Continue"
gh release view $tag --repo $repo *> $null
$exists = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = "Stop"
if ($exists) { throw "Release $tag already exists. Bump the version first." }

Write-Host "Building Rewind $version (signed)..."
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $KeyPath -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
pnpm tauri build
if ($LASTEXITCODE -ne 0) { throw "Build failed" }
Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY, Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue

$exeName = "Rewind_${version}_x64-setup.exe"
$exe = "src-tauri\target\release\bundle\nsis\$exeName"
$sig = Get-Content "$exe.sig" -Raw
$manifest = [ordered]@{
    version   = $version
    notes     = $Notes
    pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
            signature = $sig.Trim()
            url       = "https://github.com/$repo/releases/download/$tag/$exeName"
        }
    }
}
$latest = "src-tauri\target\release\bundle\nsis\latest.json"
[IO.File]::WriteAllText((Join-Path $root $latest), ($manifest | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))

$notesFile = New-TemporaryFile
@"
$Notes

### Install
Download **$exeName** below and run it. Already have Rewind? It updates itself.
Windows SmartScreen may warn because the app isn't code-signed yet: click **More info → Run anyway**.
"@ | Set-Content $notesFile

Write-Host "Publishing $tag..."
gh release create $tag $exe $latest --repo $repo --title "Rewind $version" --notes-file $notesFile --latest
Remove-Item $notesFile
Write-Host "Done: https://github.com/$repo/releases/tag/$tag"
