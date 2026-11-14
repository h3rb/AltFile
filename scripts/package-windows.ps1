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

Write-Host "Building NSIS installer..." -ForegroundColor Cyan
Push-Location $root
try {
    & cargo tauri bundle --bundles nsis
    if ($LASTEXITCODE -ne 0) { throw "cargo tauri bundle failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}
$setupSource = Get-ChildItem (Join-Path $root "src-tauri\target\release\bundle\nsis") -Filter "*-setup.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setupSource) { throw "The NSIS installer was not produced" }

$installer = Join-Path $root "dist\AltFileExplorer-$version-win-x64-setup.exe"
$rawBinary = Join-Path $root "dist\AltFileExplorer-$version-win-x64.exe"
Copy-Item $setupSource.FullName $installer -Force
Copy-Item $exe $rawBinary -Force

Write-Host ""
Write-Host "Builds ready:" -ForegroundColor Green
Write-Host "  Folder:    $out"
Write-Host "  Zip:       $zip"
Write-Host "  Installer: $installer"
Write-Host "  Binary:    $rawBinary"
