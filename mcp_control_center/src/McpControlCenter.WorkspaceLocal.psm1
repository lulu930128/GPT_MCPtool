Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

# Composition only: the existing tray owns this object and its lifetime.
function New-McpCcWorkspaceLocalOwner {
    param([Parameter(Mandatory=$true)][string]$RuntimeRoot)
    if ($null -eq ('McpCc.WorkspaceLocal.Owner' -as [type])) {
        Add-Type -Path (Join-Path $PSScriptRoot 'WorkspaceLocal.Native.cs') -ReferencedAssemblies System.Web.Extensions,System.Core
    }
    $owner=[McpCc.WorkspaceLocal.Owner]::Open($RuntimeRoot)
    try { $owner.Start(); return $owner } catch { $owner.Dispose(); throw }
}

# Pure projection of the existing sample. Never call providers or read files here.
function Get-WorkspaceLocalField {
    param($Object,[string]$Name)
    if ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name]) { return $Object.$Name }
    return $null
}

function ConvertTo-WorkspaceLocalDetail {
    param($Value,$Row)
    $local=Get-WorkspaceLocalField $Value 'localStatus'
    if (-not [McpCc.WorkspaceLocal.Contract]::Has([McpCc.WorkspaceLocal.Contract]::States,[string]$local)) { $local='UNVERIFIED' }
    $scope=Get-WorkspaceLocalField $Value 'readinessScope'
    if ($scope -cnotin @('none','local','remote_registration','end_to_end')) { $scope='UNVERIFIED' }
    $probes=@()
    if ($Row.status -cne 'UNVERIFIED') {
        foreach ($probe in @(Get-WorkspaceLocalField $Value 'probes')) {
            $role=Get-WorkspaceLocalField $probe 'role'
            if ($role -cnotin @('core','connectivity','dependency')) { continue }
            $p=[McpCc.WorkspaceLocal.ProbeDetail]::new();$p.role=$role
            $success=Get-WorkspaceLocalField $probe 'success';$tcp=Get-WorkspaceLocalField $probe 'tcpOpen'
            if ($success -is [bool]) { $p.success=$success }
            if ($tcp -is [bool]) { $p.tcpOpen=$tcp }
            $owner=Get-WorkspaceLocalField $probe 'owner'
            $known=Get-WorkspaceLocalField $owner 'known';$ownerPid=Get-WorkspaceLocalField $owner 'pid'
            if ($known -is [bool] -and $known -and ($ownerPid -is [int] -or $ownerPid -is [long]) -and $ownerPid -gt 0 -and $ownerPid -le [int]::MaxValue) {
                $p.ownerKnown=$true;$p.pid=[int]$ownerPid
                $matches=Get-WorkspaceLocalField $owner 'matchesExpected'
                if ($matches -is [bool]) { $p.matchesExpected=$matches }
            }
            if ($p.success -eq $true) {
                $summary=Get-WorkspaceLocalField $probe 'summary'
                $build=Get-WorkspaceLocalField $summary 'buildId'
                if ($build -is [string] -and $build -cmatch '\A[a-fA-F0-9]{7,64}\z') { $p.runtimeBuildId=$build }
                # Only the existing canonical Bridge health summary can supply counts.
                # Current descriptors may omit these fields; absence is never zero.
                if ($Row.componentId -ceq 'codex_bridge' -and $role -ceq 'core' -and
                    (Get-WorkspaceLocalField $summary 'service') -ceq 'codex-handoff-bridge' -and
                    (Get-WorkspaceLocalField $summary 'jobs.scope') -ceq 'all') {
                    $controller=Get-WorkspaceLocalField $summary 'controller'
                    if ($controller -is [string] -and $controller -cin @('ready','idle','starting','unavailable')) { $p.controller=$controller }
                    $activeJobs=Get-WorkspaceLocalField $summary 'jobs.active'
                    $pendingApproval=Get-WorkspaceLocalField $summary 'jobs.awaitingApproval'
                    if (($activeJobs -is [int] -or $activeJobs -is [long]) -and ($pendingApproval -is [int] -or $pendingApproval -is [long]) -and
                        $activeJobs -ge 0 -and $activeJobs -le [int]::MaxValue -and $pendingApproval -ge 0 -and $pendingApproval -le [int]::MaxValue) {
                        $p.activeJobs=[int]$activeJobs;$p.pendingApproval=[int]$pendingApproval
                    }
                }
            }
            $probes+=$p
        }
    } else { $local='UNVERIFIED';$scope='UNVERIFIED' }
    if ($probes.Count -gt 8) { throw 'DIAGNOSTICS_LIMIT' }
    return [McpCc.WorkspaceLocal.Detail]@{componentId=$Row.componentId;status=$Row.status;localStatus=$local;observedAt=$Row.observedAt;readinessScope=$scope;probes=[McpCc.WorkspaceLocal.ProbeDetail[]]$probes}
}

function Publish-McpCcWorkspaceLocalState {
    param([Parameter(Mandatory=$true)]$Owner, $State)
    try {
        $rows=@();$details=@()
        foreach ($id in [McpCc.WorkspaceLocal.Contract]::Ids) {
            $matches=@($State.components | Where-Object { $_.id -ceq $id })
            if ($matches.Count -ne 1) { throw 'SNAPSHOT_INCOMPLETE' }
            $value=$matches[0]
            $status=if ([McpCc.WorkspaceLocal.Contract]::Has([McpCc.WorkspaceLocal.Contract]::States,[string]$value.status)) { [string]$value.status } else { 'UNVERIFIED' }
            if (@($value.issues | Where-Object { $_.code -ceq 'MONITOR_EXCEPTION' }).Count) { $status='UNVERIFIED' }
            $caps=@($value.capabilities | Where-Object { [McpCc.WorkspaceLocal.Contract]::Has([McpCc.WorkspaceLocal.Contract]::Actions,[string]$_) } | Select-Object -Unique)
            $row=[McpCc.WorkspaceLocal.Row]@{componentId=$id;status=$status;observedAt=[string]$value.checkedAt;capabilities=[string[]]$caps}
            $rows += $row
            # Malformed enrichment must not disable the legacy summary/recovery channel.
            try { $details += ConvertTo-WorkspaceLocalDetail $value $row } catch { }
        }
        $Owner.Publish([McpCc.WorkspaceLocal.Snapshot]::new([McpCc.WorkspaceLocal.Row[]]$rows,[McpCc.WorkspaceLocal.Detail[]]$details))
    } catch { $Owner.Publish($null) }
}

function Invoke-McpCcWorkspaceLocalRestart {
    param([Parameter(Mandatory=$true)]$Owner, [Parameter(Mandatory=$true)]$Request,
          [Parameter(Mandatory=$true)]$Manifest, [Parameter(Mandatory=$true)][string]$RuntimeRoot)
    # No caller-supplied entrypoint/arguments. Revalidate the fixed seven targets.
    if (-not [McpCc.WorkspaceLocal.Contract]::Has([McpCc.WorkspaceLocal.Contract]::Ids, [string]$Request.componentId) -or
        $Request.action -cne 'reload_runtime' -or $Request.confirmation -cne 'interrupt_current_requests' -or
        -not [McpCc.WorkspaceLocal.Contract]::IsRequestId([string]$Request.requestId)) { throw 'INVALID_REQUEST' }
    try {
        $result=Invoke-McpCcComponentAction -Manifest $Manifest -ComponentId $Request.componentId -Action 'reload_runtime' -RuntimeRoot $RuntimeRoot
        if ($result.delegated -eq $true -and $result.exitCode -eq 0 -and $result.result.ok -eq $true) {
            $Owner.Complete($Request.requestId, 'COMPLETED')
        } else { $Owner.Complete($Request.requestId, 'UNKNOWN') }
    } catch {
        $failure=$_.Exception
        $reason=$null
        # PowerShell may wrap the typed controller failure. Bounded traversal;
        # arbitrary messages, timeouts and unvalidated output remain UNKNOWN.
        for ($depth=0; $null -ne $failure -and $depth -lt 8; $depth++) {
            $candidate=$failure.Data['McpCc.ControllerRefusalCode']
            if ($candidate -is [string] -and [McpCc.WorkspaceLocal.RefusalDiagnostic]::IsReason($candidate)) { $reason=$candidate; break }
            $failure=$failure.InnerException
        }
        if ($null -ne $reason) { $Owner.CompleteRefusal($Request.requestId, $reason) }
        else { $Owner.Complete($Request.requestId, 'UNKNOWN') }
    }
}

Export-ModuleMember -Function @('New-McpCcWorkspaceLocalOwner','Publish-McpCcWorkspaceLocalState','Invoke-McpCcWorkspaceLocalRestart')
