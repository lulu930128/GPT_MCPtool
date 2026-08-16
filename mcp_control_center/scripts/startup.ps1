param(
    [ValidateSet("Plan", "Adopt", "Restore")]
    [string]$Action = "Plan",
    [string]$ManifestPath,
    [string]$RuntimeRoot,
    [switch]$Apply
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$modulePath = Join-Path $projectRoot "src\McpControlCenter.Core.psm1"
Import-Module $modulePath -Force
if ([string]::IsNullOrWhiteSpace($ManifestPath)) { $ManifestPath = Get-McpCcDefaultManifestPath }
if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) { $RuntimeRoot = Get-McpCcDefaultRuntimeRoot }

$manifest = Read-McpCcManifest -Path $ManifestPath
if (Test-McpCcPathWithinRoot -Path $RuntimeRoot -Root $manifest.workspaceRoot) {
    throw "RuntimeRoot must be outside the source workspace."
}
$startupDirectory = [Environment]::GetFolderPath("Startup")
if ([string]::IsNullOrWhiteSpace($startupDirectory)) { throw "Could not resolve the current user's Startup folder." }
$managerShortcutName = "MCP Control Center.lnk"
$managerShortcutPath = Join-Path $startupDirectory $managerShortcutName
$managerLauncher = Join-Path $projectRoot "scripts\start-tray.vbs"
$wscript = Join-Path $env:WINDIR "System32\wscript.exe"
$shell = New-Object -ComObject WScript.Shell

function Get-ManagerShortcutStatus {
    if (-not (Test-Path -LiteralPath $managerShortcutPath -PathType Leaf)) { return "Missing" }
    try {
        $shortcut = $shell.CreateShortcut($managerShortcutPath)
        if (Test-McpCcShortcutMatches -TargetPath $shortcut.TargetPath -Arguments $shortcut.Arguments -ExpectedLauncher $managerLauncher) {
            return "Recognized"
        }
        return "Conflict"
    }
    catch { return "Conflict" }
}

function New-ManagerShortcut {
    $shortcut = $shell.CreateShortcut($managerShortcutPath)
    $shortcut.TargetPath = $wscript
    $shortcut.Arguments = "`"$managerLauncher`""
    $shortcut.WorkingDirectory = $projectRoot
    $shortcut.WindowStyle = 7
    $shortcut.Description = "Start MCP Control Center and safely reconcile enabled local MCP runtimes"
    $shortcut.Save()
    if ((Get-ManagerShortcutStatus) -ne "Recognized") { throw "Manager Startup shortcut verification failed." }
}

function Get-LatestReceipt {
    $adoptionRoot = Join-Path $RuntimeRoot "startup-adoptions"
    if (-not (Test-Path -LiteralPath $adoptionRoot -PathType Container)) { return $null }
    foreach ($directory in @(Get-ChildItem -LiteralPath $adoptionRoot -Directory | Sort-Object Name -Descending)) {
        $receiptPath = Join-Path $directory.FullName "receipt.json"
        if (Test-Path -LiteralPath $receiptPath -PathType Leaf) {
            try {
                $candidate = Get-Content -LiteralPath $receiptPath -Encoding UTF8 -Raw | ConvertFrom-Json
                if (@($candidate.movedShortcuts).Count -gt 0) { return $candidate }
            }
            catch { continue }
        }
    }
    return $null
}

function Get-ReversedItems {
    param([object[]]$Items)
    for ($index = @($Items).Count - 1; $index -ge 0; $index--) {
        Write-Output $Items[$index]
    }
}

if ($Action -in @("Plan", "Adopt")) {
    $audit = Get-McpCcStartupAudit -Manifest $manifest -StartupDirectory $startupDirectory
    $managerStatus = Get-ManagerShortcutStatus
    $alreadyAdopted = ($managerStatus -eq "Recognized" -and $audit.recognizedCount -eq 0 -and $audit.missingCount -eq @($audit.entries).Count)
    $plan = [pscustomobject]@{
        action = if ($Action -eq "Plan") { "Plan" } else { "Adopt" }
        apply = [bool]$Apply
        safeToAdopt = ($audit.conflictCount -eq 0 -and $managerStatus -ne "Conflict")
        alreadyAdopted = $alreadyAdopted
        managerShortcut = [pscustomobject]@{ path = $managerShortcutPath; status = $managerStatus; launcher = $managerLauncher }
        legacy = $audit
        effect = "Move only recognized registered-component shortcuts to a private backup, then install one MCP Control Center shortcut."
    }
    if ($Action -eq "Plan" -or -not $Apply) {
        $plan | ConvertTo-Json -Depth 8
        exit $(if ($plan.safeToAdopt) { 0 } else { 2 })
    }
    if (-not $plan.safeToAdopt) { throw "Startup adoption refused because a shortcut target conflicts with the manifest." }
    if ($plan.alreadyAdopted) {
        [pscustomobject]@{ adopted = $false; alreadyAdopted = $true; managerShortcut = $managerShortcutPath } | ConvertTo-Json -Depth 5
        exit 0
    }

    $stamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ")
    $backupDirectory = Join-Path $RuntimeRoot "startup-adoptions\$stamp"
    New-Item -ItemType Directory -Force -Path $backupDirectory | Out-Null
    $moved = @()
    try {
        foreach ($entry in @($audit.entries | Where-Object { $_.status -eq "Recognized" })) {
            $destination = Join-Path $backupDirectory ([string]$entry.shortcutName)
            if (Test-Path -LiteralPath $destination) { throw "Backup target already exists: $destination" }
            Move-Item -LiteralPath ([string]$entry.path) -Destination $destination
            $moved += [pscustomobject]@{
                component = [string]$entry.component
                originalPath = [string]$entry.path
                backupPath = $destination
            }
        }
        if ($managerStatus -eq "Missing") { New-ManagerShortcut }
        $receipt = [pscustomobject]@{
            schemaVersion = 1
            adoptedAt = [DateTime]::UtcNow.ToString("o")
            managerShortcutPath = $managerShortcutPath
            managerLauncher = $managerLauncher
            movedShortcuts = $moved
        }
        Write-McpCcJsonAtomic -Path (Join-Path $backupDirectory "receipt.json") -Document $receipt
        [pscustomobject]@{ adopted = $true; backupDirectory = $backupDirectory; managerShortcut = $managerShortcutPath; moved = $moved } | ConvertTo-Json -Depth 8
    }
    catch {
        if ((Get-ManagerShortcutStatus) -eq "Recognized" -and $managerStatus -eq "Missing") {
            Remove-Item -LiteralPath $managerShortcutPath -Force -ErrorAction SilentlyContinue
        }
        foreach ($entry in @(Get-ReversedItems -Items $moved)) {
            if ((Test-Path -LiteralPath $entry.backupPath) -and -not (Test-Path -LiteralPath $entry.originalPath)) {
                Move-Item -LiteralPath $entry.backupPath -Destination $entry.originalPath
            }
        }
        throw
    }
    exit 0
}

$receipt = Get-LatestReceipt
if ($null -eq $receipt) { throw "No Startup adoption receipt is available to restore." }
$restoreItems = @()
$restoreSafe = $true
foreach ($entry in @($receipt.movedShortcuts)) {
    $status = if (-not (Test-Path -LiteralPath ([string]$entry.backupPath))) { "BackupMissing" }
    elseif (Test-Path -LiteralPath ([string]$entry.originalPath) ) { "OriginalOccupied" }
    else { "Ready" }
    if ($status -ne "Ready") { $restoreSafe = $false }
    $restoreItems += [pscustomobject]@{ component = $entry.component; originalPath = $entry.originalPath; backupPath = $entry.backupPath; status = $status }
}
$managerStatus = Get-ManagerShortcutStatus
if ($managerStatus -eq "Conflict") { $restoreSafe = $false }
$restorePlan = [pscustomobject]@{
    action = "Restore"
    apply = [bool]$Apply
    safeToRestore = $restoreSafe
    managerShortcut = [pscustomobject]@{ path = $managerShortcutPath; status = $managerStatus }
    items = $restoreItems
}
if (-not $Apply) {
    $restorePlan | ConvertTo-Json -Depth 8
    exit $(if ($restoreSafe) { 0 } else { 2 })
}
if (-not $restoreSafe) { throw "Startup restore refused because the receipt, backup, or current shortcut state conflicts." }

if ($managerStatus -eq "Recognized") { Remove-Item -LiteralPath $managerShortcutPath -Force }
$restored = @()
try {
    foreach ($entry in @($restoreItems)) {
        Move-Item -LiteralPath ([string]$entry.backupPath) -Destination ([string]$entry.originalPath)
        $restored += $entry
    }
    [pscustomobject]@{ restored = $true; managerShortcutRemoved = ($managerStatus -eq "Recognized"); items = $restored } | ConvertTo-Json -Depth 8
}
catch {
    foreach ($entry in @(Get-ReversedItems -Items $restored)) {
        if ((Test-Path -LiteralPath $entry.originalPath) -and -not (Test-Path -LiteralPath $entry.backupPath)) {
            Move-Item -LiteralPath $entry.originalPath -Destination $entry.backupPath
        }
    }
    if ($managerStatus -eq "Recognized" -and -not (Test-Path -LiteralPath $managerShortcutPath)) { New-ManagerShortcut }
    throw
}
