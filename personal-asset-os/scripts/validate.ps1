param([switch]$RuntimeSmoke)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$env:UV_CACHE_DIR = Join-Path $ProjectRoot ".uv-cache"
$env:TEMP = Join-Path $ProjectRoot ".test-tmp-system"
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null

function Invoke-Checked([string]$Label, [scriptblock]$Action) {
    Write-Host "[$Label]"
    & $Action
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE" }
}

Push-Location $ProjectRoot
try {
    Invoke-Checked "pytest" { & uv run --frozen pytest --basetemp (Join-Path $ProjectRoot ".test-tmp") }
    Invoke-Checked "ruff" { & uv run --frozen ruff check src tests migrations }
    Invoke-Checked "mypy" { & uv run --frozen mypy src }
    Push-Location (Join-Path $ProjectRoot "frontend")
    try {
        Invoke-Checked "frontend lint" { & npm run lint }
        Invoke-Checked "frontend build" { & npm run build }
    }
    finally { Pop-Location }
    Invoke-Checked "tray self-test" { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ProjectRoot "scripts\tray.ps1") -SelfTest }
    Invoke-Checked "tunnel self-test" { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ProjectRoot "scripts\tunnel.ps1") -Action SelfTest }
    if (Test-Path -LiteralPath (Join-Path $ProjectRoot ".git")) {
        Invoke-Checked "git diff check" { & git diff --check }
    }
    if ($RuntimeSmoke) {
        Invoke-Checked "runtime smoke" { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ProjectRoot "scripts\smoke-runtime.ps1") }
    }
}
finally { Pop-Location }
