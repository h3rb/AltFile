param(
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $root "src-tauri\Cargo.toml"
$exe = Join-Path $root "src-tauri\target\release\altfileexplorer.exe"

$version = (Select-String -Path $manifest -Pattern '^version\s*=\s*"([^"]+)"').Matches[0].Groups[1].Value
if (-not $version) { throw "Could not read the version from $manifest" }

if (-not $SkipBuild) {
    Write-Host "Building release executable..." -ForegroundColor Cyan
    & cargo build --release --manifest-path $manifest
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed with exit code $LASTEXITCODE" }
}

if (-not (Test-Path $exe)) { throw "Executable not found at $exe" }

$name = "AltFileExplorer-$version-win-x64"
$out = Join-Path $root "dist\$name"
$zip = Join-Path $root "dist\$name.zip"

if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out -Force | Out-Null

Copy-Item $exe $out
Copy-Item (Join-Path $root "README.md") $out
Copy-Item (Join-Path $root "LICENSE") $out
@"
Alt File Explorer portable build
Place portable.txt next to altfileexplorer.exe to keep settings, session,
and thumbnails in the "data" folder beside the executable.
Requires the Microsoft Edge WebView2 Runtime (preinstalled on Windows 10/11).
"@ | Set-Content -Path (Join-Path $out "portable.txt") -Encoding UTF8

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $out "*") -DestinationPath $zip -CompressionLevel Optimal

Write-Host ""
Write-Host "Portable build ready:" -ForegroundColor Green
Write-Host "  Folder: $out"
Write-Host "  Zip:    $zip"
