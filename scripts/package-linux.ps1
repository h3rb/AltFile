param(
    [string]$Distro = "",
    [switch]$InstallDeps,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$linuxTargetDir = '$HOME/.cache/altfe-linux-target'

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw "WSL is required to build the Linux target from Windows. Install a WSL distro with 'wsl --install'."
}

if (-not $Distro) {
    $listing = (& wsl.exe -l -q) -join "`n"
    $names = ($listing -replace "`0", "") -split "`r?`n" |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ }
    $Distro = $names | Select-Object -First 1
    if (-not $Distro) {
        throw "No WSL distro found. Install one with 'wsl --install -d Ubuntu'."
    }
}

function Invoke-WslBash {
    param([string]$Command)
    & wsl.exe -d $Distro --cd $wslRoot -e bash -lc $Command
    if ($LASTEXITCODE -ne 0) {
        throw "WSL command failed with exit code $LASTEXITCODE"
    }
}

$wslRoot = ((& wsl.exe -d $Distro --cd $root -e pwd) -join "").Trim()
if ($LASTEXITCODE -ne 0 -or -not $wslRoot) {
    throw "Could not resolve the repository path inside WSL ($root)."
}

Write-Host "Linux target: $Distro ($wslRoot)" -ForegroundColor Cyan

if ($InstallDeps) {
    Write-Host "Installing WebKitGTK, GTK, and build dependencies..." -ForegroundColor Cyan
    & wsl.exe -d $Distro -u root -e bash -lc @"
apt-get update &&
DEBIAN_FRONTEND=noninteractive apt-get install -y \
    libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
    librsvg2-dev libssl-dev libxdo-dev build-essential pkg-config curl wget file
"@
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to install Linux build dependencies (exit code $LASTEXITCODE)."
    }
    Invoke-WslBash 'if ! command -v cargo >/dev/null 2>&1; then curl --proto ''=https'' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal; fi'
}

if (-not $SkipBuild) {
    & wsl.exe -d $Distro -e bash -lc 'export PATH="$HOME/.cargo/bin:$PATH"; command -v cargo >/dev/null 2>&1 && pkg-config --exists webkit2gtk-4.1'
    if ($LASTEXITCODE -ne 0) {
        throw "Linux build dependencies are missing in $Distro. Re-run with -InstallDeps."
    }
}

$command = 'export PATH="$HOME/.cargo/bin:$PATH"; export CARGO_TARGET_DIR="' + $linuxTargetDir + '"; '
if ($SkipBuild) {
    $command += 'export SKIP_BUILD=1; '
}
$command += 'exec bash scripts/package-linux.sh'
Invoke-WslBash $command

$tarball = Get-ChildItem (Join-Path $root "dist") -Filter "AltFileExplorer-*-linux-*.tar.gz" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if (-not $tarball) {
    throw "Linux package was not created in $root\dist."
}

Write-Host ""
Write-Host "Linux build ready:" -ForegroundColor Green
Write-Host "  Tarball: $($tarball.FullName)"
