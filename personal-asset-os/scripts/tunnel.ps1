param(
    [ValidateSet("SelfTest", "Version", "Init", "Doctor", "Health", "Run")]
    [string]$Action = "Doctor",
    [string]$ProjectRoot,
    [string]$TunnelClientPath,
    [string]$ProfileDir,
    [string]$Profile = "personal-asset-os",
    [string]$TunnelId = $env:PAOS_TUNNEL_ID,
    [string]$McpUrl = "http://127.0.0.1:18876/mcp/",
    [string]$HealthListenAddr = "127.0.0.1:18877",
    [switch]$Explain
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}
if ([string]::IsNullOrWhiteSpace($TunnelClientPath)) {
    $TunnelClientPath = Join-Path $ProjectRoot "vendor\tunnel-client\tunnel-client.exe"
}
if ([string]::IsNullOrWhiteSpace($ProfileDir)) {
    $ProfileDir = Join-Path $ProjectRoot ".tunnel-client"
}

. (Join-Path $PSScriptRoot "local-env.ps1")
if ([string]::IsNullOrWhiteSpace($TunnelId)) {
    $TunnelId = Get-LocalEnvValue -ProjectRoot $ProjectRoot -Name "PAOS_TUNNEL_ID"
}

$ProfilePath = Join-Path $ProfileDir "$Profile.yaml"
if ([string]::IsNullOrWhiteSpace($TunnelId) -and (Test-Path -LiteralPath $ProfilePath)) {
    foreach ($line in Get-Content -LiteralPath $ProfilePath -Encoding UTF8) {
        if ($line -match '^\s*tunnel_id\s*:\s*"?([^"#\s]+)') {
            $TunnelId = $matches[1]
            break
        }
    }
}

function Get-AdminBaseUrl {
    if ($HealthListenAddr -match "^https?://") { return $HealthListenAddr.TrimEnd("/") }
    return "http://$HealthListenAddr"
}

function Assert-TunnelClient {
    if (-not (Test-Path -LiteralPath $TunnelClientPath)) {
        throw "Missing tunnel-client.exe at $TunnelClientPath"
    }
}

function Assert-ControlPlaneKey {
    if (-not (Set-ControlPlaneApiKeyFromLocalEnv -ProjectRoot $ProjectRoot)) {
        throw "OPENAI_API_KEY is not configured in the local .env file."
    }
    if (-not (Set-ControlPlaneOrganizationIdFromLocalEnv -ProjectRoot $ProjectRoot)) {
        throw "CONTROL_PLANE_ORGANIZATION_ID is not configured in the local .env file."
    }
}

function Invoke-TunnelClient([string[]]$Arguments) {
    Assert-TunnelClient
    & $TunnelClientPath @Arguments
    exit $LASTEXITCODE
}

switch ($Action) {
    "SelfTest" {
        [pscustomobject]@{
            projectRoot = $ProjectRoot
            tunnelClientPath = $TunnelClientPath
            tunnelClientExists = Test-Path -LiteralPath $TunnelClientPath
            profilePath = $ProfilePath
            profileExists = Test-Path -LiteralPath $ProfilePath
            tunnelIdConfigured = -not [string]::IsNullOrWhiteSpace($TunnelId)
            controlPlaneKeyConfigured = Set-ControlPlaneApiKeyFromLocalEnv -ProjectRoot $ProjectRoot
            controlPlaneOrganizationConfigured = Set-ControlPlaneOrganizationIdFromLocalEnv -ProjectRoot $ProjectRoot
            mcpUrl = $McpUrl
            adminBaseUrl = Get-AdminBaseUrl
            credentialValuesExposed = $false
        } | ConvertTo-Json -Depth 4
        exit 0
    }
    "Version" {
        Invoke-TunnelClient @("--version")
    }
    "Init" {
        Assert-ControlPlaneKey
        if ([string]::IsNullOrWhiteSpace($TunnelId)) {
            throw "PAOS_TUNNEL_ID is required for tunnel initialization."
        }
        Invoke-TunnelClient @(
            "init",
            "--profile-dir", $ProfileDir,
            "--profile", $Profile,
            "--sample", "sample_mcp_remote_no_auth",
            "--tunnel-id", $TunnelId,
            "--mcp-server-url", $McpUrl,
            "--control-plane-api-key-ref", "env:CONTROL_PLANE_API_KEY",
            "--health-listen-addr", $HealthListenAddr,
            "--force"
        )
    }
    "Doctor" {
        Assert-ControlPlaneKey
        $arguments = @("doctor", "--profile-dir", $ProfileDir, "--profile", $Profile)
        if ($Explain) { $arguments += "--explain" }
        Invoke-TunnelClient $arguments
    }
    "Health" {
        Invoke-TunnelClient @("health", "--url", (Get-AdminBaseUrl), "--json")
    }
    "Run" {
        Assert-ControlPlaneKey
        $tmpDir = Join-Path $ProjectRoot ".tmp"
        New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
        Invoke-TunnelClient @(
            "run",
            "--profile-dir", $ProfileDir,
            "--profile", $Profile,
            "--log.file", (Join-Path $tmpDir "tunnel-client.log"),
            "--pid.file", (Join-Path $tmpDir "tunnel-client.pid")
        )
    }
}
