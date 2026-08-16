param(
  [ValidateSet("SelfTest", "Version", "Init", "Doctor", "Health", "Run", "SaveKey", "SaveKeyFromEnv", "KeyStatus")]
  [string]$Action = "Doctor",
  [string]$ProjectRoot,
  [string]$TunnelClientPath,
  [string]$ProfileDir,
  [string]$SecretPath,
  [string]$Profile = "project-workspace",
  [string]$TunnelId = $env:WORKSPACE_MCP_TUNNEL_ID,
  [string]$McpUrl = "http://127.0.0.1:18787/mcp",
  [string]$HealthListenAddr = "127.0.0.1:18788",
  [string]$ControlPlaneApiKeyRef = "env:CONTROL_PLANE_API_KEY",
  [switch]$Explain
)

Set-StrictMode -Version 2.0
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

$existingProfilePath = Join-Path $ProfileDir "$Profile.yaml"
if ([string]::IsNullOrWhiteSpace($TunnelId) -and (Test-Path -LiteralPath $existingProfilePath)) {
  foreach ($line in (Get-Content -LiteralPath $existingProfilePath -Encoding UTF8)) {
    if ($line -match '^\s*tunnel_id\s*:\s*"?([^"#\s]+)') {
      $TunnelId = $matches[1]
      break
    }
  }
}

. (Join-Path $PSScriptRoot "key-store.ps1")
$ResolvedSecretPath = Get-ControlPlaneSecretPath -ProjectRoot $ProjectRoot -SecretPath $SecretPath

function Get-AdminBaseUrl {
  if ($HealthListenAddr -match "^https?://") {
    return $HealthListenAddr.TrimEnd("/")
  }

  return "http://$HealthListenAddr"
}

function Assert-TunnelClient {
  if (-not (Test-Path -LiteralPath $TunnelClientPath)) {
    throw "Missing tunnel-client.exe at $TunnelClientPath. Install it under vendor\tunnel-client first."
  }
}

function Invoke-TunnelClient([string[]]$Arguments) {
  Assert-TunnelClient
  & $TunnelClientPath @Arguments
  exit $LASTEXITCODE
}

switch ($Action) {
  "SelfTest" {
    $profilePath = Join-Path $ProfileDir "$Profile.yaml"
    [pscustomobject]@{
      projectRoot = $ProjectRoot
      tunnelClientPath = $TunnelClientPath
      tunnelClientExists = Test-Path -LiteralPath $TunnelClientPath
      profileDir = $ProfileDir
      profile = $Profile
      profilePath = $profilePath
      profileExists = Test-Path -LiteralPath $profilePath
      secretPath = $ResolvedSecretPath
      secretExists = Test-Path -LiteralPath $ResolvedSecretPath
      tunnelId = $TunnelId
      mcpUrl = $McpUrl
      adminBaseUrl = Get-AdminBaseUrl
      apiKeyReference = $ControlPlaneApiKeyRef
    } | ConvertTo-Json -Depth 4
    exit 0
  }
  "Version" {
    Invoke-TunnelClient @("--version")
  }
  "SaveKey" {
    $secret = Read-Host -Prompt "CONTROL_PLANE_API_KEY" -AsSecureString
    $path = Save-ControlPlaneApiKeySecret -ProjectRoot $ProjectRoot -Secret $secret -SecretPath $ResolvedSecretPath
    [pscustomobject]@{
      saved = $true
      path = $path
      storage = "Windows DPAPI current-user encrypted"
    } | ConvertTo-Json -Depth 4
    exit 0
  }
  "SaveKeyFromEnv" {
    if ([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)) {
      throw "CONTROL_PLANE_API_KEY is not set in this PowerShell session."
    }
    $secret = ConvertTo-SecureString $env:CONTROL_PLANE_API_KEY -AsPlainText -Force
    $path = Save-ControlPlaneApiKeySecret -ProjectRoot $ProjectRoot -Secret $secret -SecretPath $ResolvedSecretPath
    [pscustomobject]@{
      saved = $true
      path = $path
      source = "process env:CONTROL_PLANE_API_KEY"
      storage = "Windows DPAPI current-user encrypted"
    } | ConvertTo-Json -Depth 4
    exit 0
  }
  "KeyStatus" {
    Test-ControlPlaneApiKeySecret -ProjectRoot $ProjectRoot -SecretPath $ResolvedSecretPath | ConvertTo-Json -Depth 4
    exit 0
  }
  "Init" {
    if ([string]::IsNullOrWhiteSpace($TunnelId)) {
      throw "TunnelId is required for Init. Set WORKSPACE_MCP_TUNNEL_ID or pass -TunnelId tunnel_..."
    }
    Invoke-TunnelClient @(
      "init",
      "--profile-dir", $ProfileDir,
      "--profile", $Profile,
      "--sample", "sample_mcp_remote_no_auth",
      "--tunnel-id", $TunnelId,
      "--mcp-server-url", $McpUrl,
      "--control-plane-api-key-ref", $ControlPlaneApiKeyRef,
      "--health-listen-addr", $HealthListenAddr,
      "--force"
    )
  }
  "Doctor" {
    Set-ControlPlaneApiKeyEnvFromSecret -ProjectRoot $ProjectRoot -SecretPath $ResolvedSecretPath | Out-Null
    $args = @("doctor", "--profile-dir", $ProfileDir, "--profile", $Profile)
    if ($Explain) {
      $args += "--explain"
    }
    Invoke-TunnelClient $args
  }
  "Health" {
    Invoke-TunnelClient @("health", "--url", (Get-AdminBaseUrl), "--json")
  }
  "Run" {
    Set-ControlPlaneApiKeyEnvFromSecret -ProjectRoot $ProjectRoot -SecretPath $ResolvedSecretPath | Out-Null
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
