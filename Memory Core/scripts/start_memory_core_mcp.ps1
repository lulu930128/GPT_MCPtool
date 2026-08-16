param(
    [string]$ApiBaseUrl = "http://127.0.0.1:18765",
    [ValidateRange(1, 65535)]
    [int]$Port = 18818
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$originalLocation = Get-Location
$originalApiBaseUrl = $env:MEMORY_CORE_MCP_API_BASE_URL
$originalHost = $env:MEMORY_CORE_MCP_HOST
$originalPort = $env:MEMORY_CORE_MCP_PORT
$originalToken = $env:MEMORY_CORE_MCP_CLIENT_TOKEN
$plainToken = $env:MEMORY_CORE_MCP_CLIENT_TOKEN
$tokenPointer = [IntPtr]::Zero

try {
    if ([string]::IsNullOrWhiteSpace($plainToken)) {
        $secureToken = Read-Host "Memory Core low-scope client token" -AsSecureString
        $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
        $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
    }

    if ([string]::IsNullOrWhiteSpace($plainToken)) {
        throw "Memory Core MCP client token is required."
    }

    try {
        $health = Invoke-RestMethod -Uri "$ApiBaseUrl/health" -TimeoutSec 5
    }
    catch {
        throw "Memory Core backend is not reachable at $ApiBaseUrl. Start it before MCP."
    }
    if ($health.status -ne "ok") {
        throw "Memory Core backend health is not ok."
    }

    $env:MEMORY_CORE_MCP_API_BASE_URL = $ApiBaseUrl
    $env:MEMORY_CORE_MCP_HOST = "127.0.0.1"
    $env:MEMORY_CORE_MCP_PORT = [string]$Port
    $env:MEMORY_CORE_MCP_CLIENT_TOKEN = $plainToken

    Set-Location -LiteralPath $projectRoot
    & uv --cache-dir .uv-cache run python -m memory_core.mcp.main
    if ($LASTEXITCODE -ne 0) {
        throw "Memory Core MCP exited with code $LASTEXITCODE."
    }
}
finally {
    Set-Location -LiteralPath $originalLocation
    $env:MEMORY_CORE_MCP_API_BASE_URL = $originalApiBaseUrl
    $env:MEMORY_CORE_MCP_HOST = $originalHost
    $env:MEMORY_CORE_MCP_PORT = $originalPort
    $env:MEMORY_CORE_MCP_CLIENT_TOKEN = $originalToken
    $plainToken = $null
    $originalToken = $null
    if ($tokenPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
    }
}
