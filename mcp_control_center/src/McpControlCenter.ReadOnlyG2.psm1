# DEPRECATED historical G2 prototype; not composed by the tray.
# Current path/tests: WorkspaceLocal.Native.cs and test-workspace-local.ps1.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'

# Imported only by the independently protected existing owner. Importing this
# module alone opens no listener, loads no core and performs no probe or write.
function Assert-McpCcReadOnlyG2OwnerSource {
    $root='C:\Program Files\McpControlCenterG2'
    if ($PSScriptRoot -cne "$root\mcp_control_center\src") { throw 'NO_PROTECTED_INSTALL' }
    if ($null -eq ('McpCc.ReadOnlyG2.Installation' -as [type])) { throw 'PROTECTED_BOOTSTRAP_REQUIRED' }
    $binding=[McpCc.ReadOnlyG2.Installation]::Verify()
    if ($PID -ne $binding.ownerPid) { throw 'OWNER_PROCESS_REQUIRED' }
    if (Test-Path -LiteralPath "$root\mcp_control_center\config\installed-release.json") { throw 'G2_DEPENDENCY_CLOSURE_REJECTED' }
    $registryPath="$root\mcp_control_center\config\registry.json"
    $registry=Get-Content -LiteralPath $registryPath -Encoding UTF8 -Raw | ConvertFrom-Json
    $folders=@{project_reading='project_reading';codex_bridge='codex_bridge';omi_search='OMI_search';japanese_study='japanese_study';memory_core='Memory Core';personal_asset_os='personal-asset-os';english_study='english_study';listening_audio='listening_audio'}
    if ($registry.schemaVersion -ne 3 -or @($registry.components).Count -ne 8) { throw 'G2_REGISTRY_REJECTED' }
    $seen=@{}
    foreach ($entry in $registry.components) {
        $id=[string]$entry.id
        if (-not $folders.ContainsKey($id) -or $seen.ContainsKey($id) -or
            $entry.root -cne "..\..\$($folders[$id])" -or $entry.descriptor -cne 'control-center\component.json') { throw 'G2_REGISTRY_REJECTED' }
        $seen[$id]=$true
        $descriptor="$($folders[$id])/control-center/component.json"
        if (-not $binding.files.ContainsKey($descriptor)) { throw 'G2_DESCRIPTOR_NOT_PINNED' }
    }
    return $registryPath
}

function ConvertTo-McpCcReadOnlyG2Snapshot {
    param([Parameter(Mandatory=$true)]$State)
    # Project fields, never serialize core objects, URLs, errors, PID, paths,
    # probe response bodies, display names or domain data across the pipe.
    $rows=@()
    foreach ($id in [McpCc.ReadOnlyG2.Contract]::Ids) {
        $matches=@($State.components | Where-Object { $_.id -ceq $id })
        if ($matches.Count -ne 1) { throw 'G2_SAMPLE_INCOMPLETE' }
        $value=$matches[0]
        $status=if ([McpCc.ReadOnlyG2.Contract]::Has([McpCc.ReadOnlyG2.Contract]::States,[string]$value.status)) { [string]$value.status } else { 'UNVERIFIED' }
        $caps=@($value.capabilities | Where-Object { [McpCc.ReadOnlyG2.Contract]::Has([McpCc.ReadOnlyG2.Contract]::Actions,[string]$_) } | Select-Object -Unique)
        $rows += [McpCc.ReadOnlyG2.Row]@{componentId=$id;status=$status;observedAt=[string]$value.checkedAt;capabilities=[string[]]$caps}
    }
    return [McpCc.ReadOnlyG2.Snapshot]::new([McpCc.ReadOnlyG2.Row[]]$rows)
}

function Get-McpCcReadOnlyG2Snapshot {
    $registryPath=Assert-McpCcReadOnlyG2OwnerSource
    Import-Module (Join-Path $PSScriptRoot 'McpControlCenter.Core.psm1') -Force -ErrorAction Stop
    $manifest=McpControlCenter.Core\Read-McpCcManifest -Path $registryPath
    # Exclude Workspace BEFORE probes. No CLI Status, state/event writer, remote
    # evidence file, action invocation, controller Status or reconciliation.
    $manifest.components=@($manifest.components | Where-Object { $_.id -cin [McpCc.ReadOnlyG2.Contract]::Ids })
    $state=McpControlCenter.Core\Get-McpCcSystemState -Manifest $manifest -BootId 'readonly-g2' -PortPolicy $null -StatusProvider {
        param($component,$timeout)
        McpControlCenter.Core\Get-McpCcComponentStatus -Component $component -TimeoutSeconds 1 -RemoteEvidence $null -PortPolicy $null
    }
    return ConvertTo-McpCcReadOnlyG2Snapshot $state
}

function New-McpCcReadOnlyG2Owner {
    $null=Assert-McpCcReadOnlyG2OwnerSource
    $owner=[McpCc.ReadOnlyG2.Owner]::Open()
    try { $owner.Publish((Get-McpCcReadOnlyG2Snapshot));$owner.Start();return $owner }
    catch { $owner.Dispose();throw }
}

function Update-McpCcReadOnlyG2Owner {
    param([Parameter(Mandatory=$true)]$Owner)
    # Called by the existing owner's refresh runspace, outside the IPC worker.
    # A failed/slow sample expires after 30s and cannot keep reporting Ready.
    $Owner.Publish((Get-McpCcReadOnlyG2Snapshot))
}

Export-ModuleMember -Function @('New-McpCcReadOnlyG2Owner','Update-McpCcReadOnlyG2Owner','ConvertTo-McpCcReadOnlyG2Snapshot')
