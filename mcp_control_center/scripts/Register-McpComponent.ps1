param(
    [string]$ComponentRoot,
    [string]$RegistryPath,
    [Nullable[int]]$StartupOrder,
    [string]$ExpectedRegistrySha256,
    [string]$ReceiptRoot,
    [string]$RollbackReceipt,
    [switch]$Plan,
    [switch]$Apply
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$managerRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$modulePath = Join-Path $managerRoot "src\McpControlCenter.Core.psm1"
$validatorPath = Join-Path $PSScriptRoot "Test-McpComponent.ps1"
Import-Module $modulePath -Force
if (([bool]$Plan) -eq ([bool]$Apply)) { throw "Specify exactly one of -Plan or -Apply." }
if ([string]::IsNullOrWhiteSpace($RegistryPath)) { $RegistryPath = Get-McpCcDefaultManifestPath }
if ([string]::IsNullOrWhiteSpace($ReceiptRoot)) { $ReceiptRoot = Join-Path (Get-McpCcDefaultRuntimeRoot) "registration-receipts" }
$startupOrderSpecified = $PSBoundParameters.ContainsKey("StartupOrder")

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return ([string](Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash).ToLowerInvariant()
}

function Write-BytesAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][byte[]]$Bytes
    )
    $directory = Split-Path -Parent $Path
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $temporaryPath = Join-Path $directory ((Split-Path -Leaf $Path) + ".tmp.$PID." + [Guid]::NewGuid().ToString("N"))
    try {
        [IO.File]::WriteAllBytes($temporaryPath, $Bytes)
        Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
    }
}

function Assert-CanonicalRegistryPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    if (-not (Split-Path -Leaf $resolved).Equals("registry.json", [StringComparison]::OrdinalIgnoreCase) -or
        -not (Split-Path -Leaf (Split-Path -Parent $resolved)).Equals("config", [StringComparison]::OrdinalIgnoreCase) -or
        -not (Split-Path -Leaf (Split-Path -Parent (Split-Path -Parent $resolved))).Equals("mcp_control_center", [StringComparison]::OrdinalIgnoreCase)) {
        throw "Registry path must be mcp_control_center\config\registry.json."
    }
    return $resolved
}

function Resolve-PrivateReceiptRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$WorkspaceRoot
    )
    $resolved = [IO.Path]::GetFullPath($Root)
    if (Test-McpCcPathWithinRoot -Path $resolved -Root $WorkspaceRoot) {
        throw "Registration receipts must be stored outside the source workspace."
    }
    return $resolved
}

function Read-RegistryContext {
    param([Parameter(Mandatory = $true)][string]$Path)
    $resolved = Assert-CanonicalRegistryPath -Path $Path
    $item = Get-Item -LiteralPath $resolved -ErrorAction Stop
    if ($item.Length -gt 131072) { throw "Registry exceeds the 131072 byte limit." }
    $document = [IO.File]::ReadAllText($resolved, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ([int]$document.schemaVersion -ne 3) { throw "Registration requires registry schemaVersion 3." }
    $manifest = Read-McpCcManifest -Path $resolved
    $configRoot = Split-Path -Parent $resolved
    $resolvedManagerRoot = Split-Path -Parent $configRoot
    $workspaceRoot = Split-Path -Parent $resolvedManagerRoot
    return [pscustomobject]@{
        path = $resolved
        sha256 = Get-Sha256 -Path $resolved
        bytes = [IO.File]::ReadAllBytes($resolved)
        document = $document
        manifest = $manifest
        workspaceRoot = $workspaceRoot
    }
}

function Get-RegistrationPlan {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][string]$CandidateRoot,
        [Parameter(Mandatory = $true)][string]$PrivateReceiptRoot
    )
    $resolvedCandidateRoot = (Resolve-Path -LiteralPath $CandidateRoot -ErrorAction Stop).Path
    $validationText = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $validatorPath -ComponentRoot $resolvedCandidateRoot -WorkspaceRoot $Context.workspaceRoot
    if ($LASTEXITCODE -ne 0) { throw "Component candidate validation failed. $($validationText -join ' ')" }
    $validation = $validationText | ConvertFrom-Json
    $candidate = Read-McpCcComponentCandidate -ComponentRoot $resolvedCandidateRoot -WorkspaceRoot $Context.workspaceRoot
    $registeredComponents = if ($null -ne $Context.manifest.PSObject.Properties["registeredComponents"]) { @($Context.manifest.registeredComponents) } else { @($Context.manifest.components) }
    $conflicts = @()
    if (@($registeredComponents | Where-Object { $_.id -eq $candidate.id }).Count -gt 0) { $conflicts += "duplicate_id" }
    if (@($registeredComponents | Where-Object { $_.resolvedRoot.Equals($candidate.resolvedRoot, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) { $conflicts += "duplicate_root" }
    $usedPorts = @{}
    foreach ($registered in $registeredComponents) {
        foreach ($probe in @($registered.probes | Where-Object { $_.role -in @("core", "connectivity") })) {
            $usedPorts[[string][int]$probe.port] = "$($registered.id)/$($probe.id)"
        }
    }
    foreach ($probe in @($candidate.probes | Where-Object { $_.role -in @("core", "connectivity") })) {
        $portKey = [string][int]$probe.port
        if ($usedPorts.ContainsKey($portKey)) { $conflicts += "duplicate_owned_port:${portKey}:$($usedPorts[$portKey])" }
    }
    $usedOrders = @($Context.manifest.registryEntries | ForEach-Object { [int]$_.startupOrder })
    if ($startupOrderSpecified -and $null -ne $StartupOrder) {
        $proposedOrder = [int]$StartupOrder
    }
    else {
        $proposedOrder = if ($usedOrders.Count -eq 0) { 10 } else { ([int]($usedOrders | Measure-Object -Maximum).Maximum) + 10 }
    }
    if ($proposedOrder -lt 0 -or $proposedOrder -gt 10000) { $conflicts += "startup_order_out_of_range" }
    if ($proposedOrder -in $usedOrders) { $conflicts += "duplicate_startup_order" }
    $entry = [pscustomobject]@{
        id = [string]$candidate.id
        root = "..\..\$(Split-Path -Leaf $candidate.resolvedRoot)"
        descriptor = "control-center\component.json"
        enabled = $false
        autoStart = $false
        startupOrder = $proposedOrder
    }
    return [pscustomobject]@{
        action = "Register"
        apply = [bool]$Apply
        safeToApply = ($conflicts.Count -eq 0 -and [bool]$validation.registrationReady)
        registryPath = $Context.path
        registrySha256 = $Context.sha256
        receiptRoot = $PrivateReceiptRoot
        componentId = [string]$candidate.id
        componentRoot = [string]$candidate.resolvedRoot
        descriptorSha256 = Get-Sha256 -Path $candidate.descriptorPath
        entry = $entry
        validation = $validation
        conflicts = $conflicts
        effects = @("append_disabled_registry_entry", "write_private_receipt", "no_component_change", "no_startup_change", "no_process_start")
    }
}

if (-not [string]::IsNullOrWhiteSpace($RollbackReceipt)) {
    $receiptPath = (Resolve-Path -LiteralPath $RollbackReceipt -ErrorAction Stop).Path
    $receiptDirectory = Split-Path -Parent $receiptPath
    $receipt = [IO.File]::ReadAllText($receiptPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ([int]$receipt.schemaVersion -ne 1 -or [string]$receipt.operation -ne "register") { throw "Unsupported registration receipt." }
    $rollbackRegistryPath = Assert-CanonicalRegistryPath -Path ([string]$receipt.registryPath)
    $rollbackManagerRoot = Split-Path -Parent (Split-Path -Parent $rollbackRegistryPath)
    $rollbackWorkspaceRoot = Split-Path -Parent $rollbackManagerRoot
    $null = Resolve-PrivateReceiptRoot -Root $receiptDirectory -WorkspaceRoot $rollbackWorkspaceRoot
    $backupPath = (Resolve-Path -LiteralPath ([string]$receipt.backupPath) -ErrorAction Stop).Path
    if (-not (Test-McpCcPathWithinRoot -Path $backupPath -Root $receiptDirectory)) { throw "Receipt backup must remain inside its receipt directory." }
    $currentHash = Get-Sha256 -Path $rollbackRegistryPath
    $backupHash = Get-Sha256 -Path $backupPath
    $rollbackSafe = (
        $currentHash.Equals([string]$receipt.afterSha256, [StringComparison]::OrdinalIgnoreCase) -and
        $backupHash.Equals([string]$receipt.beforeSha256, [StringComparison]::OrdinalIgnoreCase)
    )
    $rollbackPlan = [pscustomobject]@{
        action = "RollbackRegistration"
        apply = [bool]$Apply
        safeToApply = $rollbackSafe
        componentId = [string]$receipt.componentId
        registryPath = $rollbackRegistryPath
        currentRegistrySha256 = $currentHash
        expectedCurrentSha256 = [string]$receipt.afterSha256
        backupPath = $backupPath
        backupSha256 = $backupHash
        expectedBackupSha256 = [string]$receipt.beforeSha256
        effects = @("restore_exact_registry_backup", "keep_component_root", "keep_receipt", "no_startup_change", "no_process_start")
    }
    if ($Plan) {
        $rollbackPlan | ConvertTo-Json -Depth 6
        exit $(if ($rollbackSafe) { 0 } else { 2 })
    }
    if ([string]::IsNullOrWhiteSpace($ExpectedRegistrySha256) -or
        -not $currentHash.Equals($ExpectedRegistrySha256, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Rollback requires the current registry SHA-256 from its plan."
    }
    if (-not $rollbackSafe) { throw "Registration rollback is unsafe because current or backup hash does not match the receipt." }
    $mutex = New-Object Threading.Mutex($false, "Local\McpControlCenter.RegistryMutation")
    $acquired = $false
    try {
        try { $acquired = $mutex.WaitOne(0, $false) }
        catch [Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) { throw "Another registry mutation is already active." }
        $currentBytes = [IO.File]::ReadAllBytes($rollbackRegistryPath)
        $currentHash = Get-Sha256 -Path $rollbackRegistryPath
        if (-not $currentHash.Equals($ExpectedRegistrySha256, [StringComparison]::OrdinalIgnoreCase)) { throw "Registry changed after rollback plan." }
        try {
            Write-BytesAtomic -Path $rollbackRegistryPath -Bytes ([IO.File]::ReadAllBytes($backupPath))
            $null = Read-McpCcManifest -Path $rollbackRegistryPath
            Write-McpCcJsonAtomic -Path (Join-Path $receiptDirectory "rollback.json") -Document ([pscustomobject]@{
                schemaVersion = 1
                operation = "rollback_registration"
                rolledBackAt = [DateTime]::UtcNow.ToString("o")
                componentId = [string]$receipt.componentId
                registryPath = $rollbackRegistryPath
                restoredSha256 = Get-Sha256 -Path $rollbackRegistryPath
            })
        }
        catch {
            Write-BytesAtomic -Path $rollbackRegistryPath -Bytes $currentBytes
            throw
        }
        [pscustomobject]@{
            action = "RollbackRegistration"
            applied = $true
            componentId = [string]$receipt.componentId
            registryPath = $rollbackRegistryPath
            registrySha256 = Get-Sha256 -Path $rollbackRegistryPath
            componentRootKept = $true
            processStarted = $false
        } | ConvertTo-Json -Depth 5
    }
    finally {
        if ($acquired) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
    exit 0
}

if ([string]::IsNullOrWhiteSpace($ComponentRoot)) { throw "Registration requires -ComponentRoot." }
$context = Read-RegistryContext -Path $RegistryPath
$privateReceiptRoot = Resolve-PrivateReceiptRoot -Root $ReceiptRoot -WorkspaceRoot $context.workspaceRoot
$registrationPlan = Get-RegistrationPlan -Context $context -CandidateRoot $ComponentRoot -PrivateReceiptRoot $privateReceiptRoot
if ($Plan) {
    $registrationPlan | ConvertTo-Json -Depth 10
    exit $(if ($registrationPlan.safeToApply) { 0 } else { 2 })
}
if ([string]::IsNullOrWhiteSpace($ExpectedRegistrySha256) -or
    -not $context.sha256.Equals($ExpectedRegistrySha256, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Register -Apply requires the current registry SHA-256 from Register -Plan."
}
if (-not $registrationPlan.safeToApply) { throw "Registration plan contains conflict(s): $($registrationPlan.conflicts -join ', ')" }

$mutationMutex = New-Object Threading.Mutex($false, "Local\McpControlCenter.RegistryMutation")
$mutationAcquired = $false
try {
    try { $mutationAcquired = $mutationMutex.WaitOne(0, $false) }
    catch [Threading.AbandonedMutexException] { $mutationAcquired = $true }
    if (-not $mutationAcquired) { throw "Another registry mutation is already active." }
    $context = Read-RegistryContext -Path $RegistryPath
    if (-not $context.sha256.Equals($ExpectedRegistrySha256, [StringComparison]::OrdinalIgnoreCase)) { throw "Registry changed after registration plan." }
    $registrationPlan = Get-RegistrationPlan -Context $context -CandidateRoot $ComponentRoot -PrivateReceiptRoot $privateReceiptRoot
    if (-not $registrationPlan.safeToApply) { throw "Registration became unsafe: $($registrationPlan.conflicts -join ', ')" }
    $stamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ")
    $receiptDirectory = Join-Path $privateReceiptRoot ("$stamp-$($registrationPlan.componentId)-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
    [IO.Directory]::CreateDirectory($receiptDirectory) | Out-Null
    $backupPath = Join-Path $receiptDirectory "registry.before.json"
    [IO.File]::WriteAllBytes($backupPath, $context.bytes)
    $beforeHash = Get-Sha256 -Path $backupPath
    if (-not $beforeHash.Equals($context.sha256, [StringComparison]::OrdinalIgnoreCase)) { throw "Registry backup verification failed." }
    $newDocument = $context.document
    $newDocument.components = @($newDocument.components) + $registrationPlan.entry
    $newBytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($newDocument | ConvertTo-Json -Depth 20))
    try {
        Write-BytesAtomic -Path $context.path -Bytes $newBytes
        $validated = Read-McpCcManifest -Path $context.path
        if (@($validated.registryEntries | Where-Object { $_.id -eq $registrationPlan.componentId }).Count -ne 1) {
            throw "Registered component was not found exactly once after write."
        }
        $afterHash = Get-Sha256 -Path $context.path
        $receiptPath = Join-Path $receiptDirectory "receipt.json"
        Write-McpCcJsonAtomic -Path $receiptPath -Document ([pscustomobject]@{
            schemaVersion = 1
            operation = "register"
            registeredAt = [DateTime]::UtcNow.ToString("o")
            componentId = $registrationPlan.componentId
            componentRoot = $registrationPlan.componentRoot
            descriptorSha256 = $registrationPlan.descriptorSha256
            registryPath = $context.path
            beforeSha256 = $context.sha256
            afterSha256 = $afterHash
            backupPath = $backupPath
            entry = $registrationPlan.entry
        })
        [pscustomobject]@{
            action = "Register"
            applied = $true
            componentId = $registrationPlan.componentId
            registryPath = $context.path
            registrySha256 = $afterHash
            entry = $registrationPlan.entry
            receiptPath = $receiptPath
            enabled = $false
            autoStart = $false
            startupChanged = $false
            processStarted = $false
        } | ConvertTo-Json -Depth 8
    }
    catch {
        Write-BytesAtomic -Path $context.path -Bytes $context.bytes
        throw
    }
}
finally {
    if ($mutationAcquired) { $mutationMutex.ReleaseMutex() }
    $mutationMutex.Dispose()
}
