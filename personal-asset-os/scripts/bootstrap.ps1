param([switch]$SkipValidation)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$env:UV_CACHE_DIR = Join-Path $ProjectRoot ".uv-cache"

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw "uv is required but was not found in PATH." }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm is required but was not found in PATH." }

Push-Location $ProjectRoot
try {
    & uv sync --dev --frozen
    if ($LASTEXITCODE -ne 0) { throw "uv sync failed with exit code $LASTEXITCODE" }
    & uv run --frozen personal-asset-os migrate
    if ($LASTEXITCODE -ne 0) { throw "database migration failed with exit code $LASTEXITCODE" }

    Push-Location (Join-Path $ProjectRoot "frontend")
    try {
        & npm ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw "frontend build failed with exit code $LASTEXITCODE" }
    }
    finally { Pop-Location }

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ProjectRoot "scripts\tray.ps1") -SelfTest
    if ($LASTEXITCODE -ne 0) { throw "tray self-test failed with exit code $LASTEXITCODE" }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ProjectRoot "scripts\tunnel.ps1") -Action SelfTest
    if ($LASTEXITCODE -ne 0) { throw "tunnel self-test failed with exit code $LASTEXITCODE" }

    if (-not $SkipValidation) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ProjectRoot "scripts\validate.ps1")
        if ($LASTEXITCODE -ne 0) { throw "validation failed with exit code $LASTEXITCODE" }
    }
}
finally { Pop-Location }

Write-Host "Personal Asset OS bootstrap complete. Start scripts\start-tray.vbs."
