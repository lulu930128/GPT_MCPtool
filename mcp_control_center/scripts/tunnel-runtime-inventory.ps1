param(
    [ValidateSet("SelfTest", "Inventory")][string]$Action = "Inventory",
    [string]$WorkspaceRoot,
    [string]$InventoryPath,
    [ValidateRange(1, 15)][int]$VersionTimeoutSeconds = 5,
    [ValidateRange(1024, 16384)][int]$MaxVersionOutputBytes = 4096
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) { $WorkspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path }
if ([string]::IsNullOrWhiteSpace($InventoryPath)) { $InventoryPath = Join-Path $PSScriptRoot "..\config\tunnel-runtime-inventory.json" }
$workspace = (Resolve-Path -LiteralPath $WorkspaceRoot -ErrorAction Stop).Path
$inventoryFile = (Resolve-Path -LiteralPath $InventoryPath -ErrorAction Stop).Path

function Resolve-InventoryChildPath {
    param([Parameter(Mandatory = $true)][string]$RelativePath)
    if ([IO.Path]::IsPathRooted($RelativePath)) { throw "Inventory paths must be workspace-relative." }
    $resolved = [IO.Path]::GetFullPath((Join-Path $workspace $RelativePath))
    if (-not $resolved.StartsWith($workspace.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Inventory path escapes the workspace." }
    return $resolved
}

try { $inventory = Get-Content -LiteralPath $inventoryFile -Encoding UTF8 -Raw | ConvertFrom-Json }
catch { throw "Tunnel runtime inventory is invalid JSON." }
if ([int]$inventory.schemaVersion -ne 1 -or [string]$inventory.contractVersion -ne "tunnel-runtime-inventory-v1") { throw "Unsupported tunnel runtime inventory contract." }
if (@($inventory.components).Count -ne 7) { throw "Tunnel runtime inventory must declare seven production components." }
$ids = @($inventory.components | ForEach-Object { [string]$_.id })
if (@($ids | Sort-Object -Unique).Count -ne 7 -or @($ids | Where-Object { $_ -notmatch '^[a-z][a-z0-9_]{0,63}$' }).Count -gt 0) { throw "Tunnel runtime inventory component ids are invalid or duplicated." }
foreach ($entry in @($inventory.components)) {
    if ([string]$entry.source -notin @("legacy_shared_provider", "legacy_shared", "component_local", "shared", "override")) { throw "Tunnel runtime source label is invalid." }
    if ([string]$entry.override -ne "TunnelClientPath") { throw "Tunnel runtime override must remain the explicit TunnelClientPath parameter." }
    $null = Resolve-InventoryChildPath -RelativePath ([string]$entry.path)
}
$sharedPath = Resolve-InventoryChildPath -RelativePath ([string]$inventory.sharedRuntime.path)
$sharedManifestPath = Resolve-InventoryChildPath -RelativePath ([string]$inventory.sharedRuntime.manifestPath)

if ($Action -eq "SelfTest") {
    [pscustomobject]@{
        ok = $true
        contractVersion = "tunnel-runtime-inventory-v1"
        configuredComponentCount = 7
        boundedVersionTimeoutSeconds = $VersionTimeoutSeconds
        boundedVersionOutputBytes = $MaxVersionOutputBytes
        executesVersionOnly = $true
        mutatesRuntime = $false
        updatesBinary = $false
    } | ConvertTo-Json -Depth 4
    exit 0
}

function Get-TunnelBinaryEvidence {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [pscustomobject]@{ exists = $false; version = $null; sha256 = $null; sizeBytes = $null; modifiedAt = $null; versionErrorCode = "TUNNEL_CLIENT_MISSING" }
    }
    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    $sha256 = ([string](Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash).ToLowerInvariant()
    $process = $null
    try {
        $startInfo = New-Object Diagnostics.ProcessStartInfo
        $startInfo.FileName = $Path; $startInfo.Arguments = "--version"; $startInfo.WorkingDirectory = Split-Path -Parent $Path
        $startInfo.UseShellExecute = $false; $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true; $startInfo.RedirectStandardError = $true
        $process = New-Object Diagnostics.Process; $process.StartInfo = $startInfo
        if (-not $process.Start()) { throw "start failed" }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync(); $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($VersionTimeoutSeconds * 1000)) { try { $process.Kill() } catch { }; $process.WaitForExit(); throw "timeout" }
        $text = (($stdoutTask.GetAwaiter().GetResult()) + [Environment]::NewLine + ($stderrTask.GetAwaiter().GetResult())).Trim()
        if ([Text.Encoding]::UTF8.GetByteCount($text) -gt $MaxVersionOutputBytes) { throw "output too large" }
        $version = if ($process.ExitCode -eq 0 -and $text -match '(?<!\d)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?!\d)') { $matches[1] } else { $null }
        $versionErrorCode = if ($process.ExitCode -ne 0) { "TUNNEL_VERSION_COMMAND_FAILED" } elseif ([string]::IsNullOrWhiteSpace($version)) { "TUNNEL_VERSION_UNKNOWN" } else { $null }
    }
    catch {
        $version = $null
        $versionErrorCode = if ([string]$_.Exception.Message -eq "timeout") { "TUNNEL_VERSION_TIMEOUT" } elseif ([string]$_.Exception.Message -eq "output too large") { "TUNNEL_VERSION_OUTPUT_TOO_LARGE" } else { "TUNNEL_VERSION_COMMAND_FAILED" }
    }
    finally { if ($null -ne $process) { $process.Dispose() } }
    return [pscustomobject]@{
        exists = $true; version = $version; sha256 = $sha256; sizeBytes = [int64]$item.Length
        modifiedAt = $item.LastWriteTimeUtc.ToString("o"); versionErrorCode = $versionErrorCode
    }
}

$binaryCache = @{}
function Get-CachedBinaryEvidence([string]$Path) {
    $key = $Path.ToLowerInvariant()
    if (-not $binaryCache.ContainsKey($key)) { $binaryCache[$key] = Get-TunnelBinaryEvidence -Path $Path }
    return $binaryCache[$key]
}

$components = @()
foreach ($entry in @($inventory.components)) {
    $path = Resolve-InventoryChildPath -RelativePath ([string]$entry.path)
    $binary = Get-CachedBinaryEvidence -Path $path
    $components += [pscustomobject]@{
        component = [string]$entry.id; source = [string]$entry.source; override = [string]$entry.override
        path = $path; exists = [bool]$binary.exists; version = $binary.version; sha256 = $binary.sha256
        sizeBytes = $binary.sizeBytes; modifiedAt = $binary.modifiedAt; versionErrorCode = $binary.versionErrorCode
    }
}
$sharedBinary = Get-CachedBinaryEvidence -Path $sharedPath
$sharedManifestExists = Test-Path -LiteralPath $sharedManifestPath -PathType Leaf
$cohorts = @($components | Where-Object { $_.exists } | Group-Object sha256 | ForEach-Object {
    [pscustomobject]@{
        sha256 = [string]$_.Name
        version = [string](@($_.Group.version | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1)[0])
        components = @($_.Group.component | Sort-Object)
        paths = @($_.Group.path | Sort-Object -Unique)
    }
})
$warnings = @()
if (-not $sharedBinary.exists) { $warnings += "SHARED_TUNNEL_RUNTIME_MISSING" }
if (-not $sharedManifestExists) { $warnings += "SHARED_TUNNEL_MANIFEST_MISSING" }
if ($cohorts.Count -gt 1) { $warnings += "MULTIPLE_TUNNEL_BINARY_COHORTS" }
if (@($components | Where-Object { -not $_.exists }).Count -gt 0) { $warnings += "COMPONENT_TUNNEL_BINARY_MISSING" }
if (@($components | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.versionErrorCode) }).Count -gt 0) { $warnings += "TUNNEL_VERSION_EVIDENCE_INCOMPLETE" }
[pscustomobject]@{
    contractVersion = "tunnel-runtime-inventory-v1"; generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    adoptionReady = ([bool]$sharedBinary.exists -and $sharedManifestExists -and [string]::IsNullOrWhiteSpace([string]$sharedBinary.versionErrorCode))
    updatesBinary = $false; components = $components
    sharedRuntime = [pscustomobject]@{ path = $sharedPath; manifestPath = $sharedManifestPath; manifestExists = $sharedManifestExists; binary = $sharedBinary }
    cohorts = $cohorts; warnings = @($warnings | Sort-Object -Unique)
} | ConvertTo-Json -Depth 8
