param([int]$Port = 18876)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$PythonPath = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
$SmokeRoot = Join-Path ([IO.Path]::GetTempPath()) ("personal-asset-os-smoke-" + [Guid]::NewGuid().ToString("N"))
$process = $null

try {
    New-Item -ItemType Directory -Path $SmokeRoot | Out-Null
    $arguments = "-m personal_asset_os.cli serve --host 127.0.0.1 --port $Port --data-dir `"$SmokeRoot`""
    $process = Start-Process -FilePath $PythonPath -WorkingDirectory $ProjectRoot -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    $health = $null
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $health = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:${Port}/api/health" -TimeoutSec 2
            if ($health.ok -eq $true) { break }
        }
        catch { Start-Sleep -Milliseconds 350 }
    }
    if ($null -eq $health -or $health.ok -ne $true) { throw "Health did not become ready." }
    $expectedBuildId = (& $PythonPath -m personal_asset_os.cli build-id).Trim()
    if ([string]$health.buildId -ne $expectedBuildId) { throw "Runtime build ID does not match source." }
    $dashboard = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:${Port}/api/dashboard" -TimeoutSec 5
    if ([string]$dashboard.base_currency -ne "TWD") { throw "Dashboard base currency mismatch." }
    $ready = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:${Port}/api/readyz" -TimeoutSec 5
    if ($ready.ready -ne $true) { throw "Runtime readiness failed." }
    $mcpJson = & $PythonPath (Join-Path $ProjectRoot "scripts\smoke-mcp.py") --url "http://127.0.0.1:${Port}/mcp/"
    if ($LASTEXITCODE -ne 0) { throw "MCP protocol smoke failed with exit code $LASTEXITCODE" }
    $mcp = $mcpJson | ConvertFrom-Json
    if ($mcp.ok -ne $true -or $mcp.policy -ne "private-tunnel-read-only") {
        throw "MCP protocol policy check failed."
    }
    [pscustomobject]@{
        ok = $true
        pid = $process.Id
        port = $Port
        buildId = $health.buildId
        schemaRevision = $health.schemaRevision
        frontendReady = $ready.frontendReady
        mcpTools = @($mcp.tools).Count
        mcpPolicy = $mcp.policy
    } | ConvertTo-Json
}
finally {
    if ($null -ne $process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        Wait-Process -Id $process.Id -Timeout 5 -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $SmokeRoot) {
        $resolved = (Resolve-Path -LiteralPath $SmokeRoot).Path
        $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
        if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and $resolved.Contains("personal-asset-os-smoke-")) {
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
    }
}
