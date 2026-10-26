Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

# Only the source registry may compile C#. Installed code is pinned by the
# existing immutable tree, not a second manifest or caller-selected DLL path.
function Initialize-McpCcWorkspaceLocalNative {
    param($Manifest)
    $installed=Test-Path -LiteralPath (Join-Path $PSScriptRoot '..\config\installed-release.json') -PathType Leaf
    $version=if ($null -eq $Manifest) { 3 } else { $Manifest.schemaVersion }
    if ($version -notin @(3,4) -or ($installed -and $version -ne 4)) { throw 'WORKSPACE_LOCAL_REGISTRY_VERSION_REJECTED' }
    if ($version -eq 3) {
        if ($null -eq ('McpCc.WorkspaceLocal.Owner' -as [type])) {
            Add-Type -Path (Join-Path $PSScriptRoot 'WorkspaceLocal.Native.cs') -ReferencedAssemblies System.Web.Extensions,System.Core
        }
        return
    }
    $manager=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    # tray.ps1 already imported the verifier and checked activation/closure
    # before taking its mutex. Reuse its exported protected-path validator;
    # do not re-import, repeat the tree scan or create another activation gate.
    $release=$Manifest.installedRelease
    if ($release.schemaVersion -lt 3) { throw 'INSTALLED_LIFECYCLE_BINDINGS_REQUIRED' }
    if ((Join-Path $release.root 'mcp_control_center') -ine $manager) { throw 'WORKSPACE_LOCAL_RELEASE_MISMATCH' }
    $native=Join-Path $manager 'src\WorkspaceLocal.Native.dll'
    if (-not (Test-Path -LiteralPath $native -PathType Leaf)) { throw 'WORKSPACE_LOCAL_NATIVE_MISSING' }
    Assert-McpCcProtectedCodePath $native
    # Resolve the required framework serializer explicitly before the helper.
    $serializer='System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35'
    Add-Type -AssemblyName $serializer
    $names=@('Owner','Contract','Row','ProbeDetail','Detail','Snapshot','RestartRequest','Receipt','RefusalDiagnostic')
    # Reject an earlier source/other-release load before Add-Type can reuse it.
    foreach ($name in $names) {
        $type=('McpCc.WorkspaceLocal.'+$name) -as [type]
        if ($null -ne $type -and $type.Assembly.Location -ine $native) { throw 'WORKSPACE_LOCAL_ASSEMBLY_SOURCE_REJECTED' }
    }
    if ($null -eq ('McpCc.WorkspaceLocal.Owner' -as [type])) { Add-Type -Path $native }
    foreach ($name in $names) {
        $type=('McpCc.WorkspaceLocal.'+$name) -as [type]
        if ($null -eq $type -or $type.Assembly.Location -ine $native) { throw 'WORKSPACE_LOCAL_ASSEMBLY_SOURCE_REJECTED' }
        if ($type.Assembly.GetName().Name -cne 'WorkspaceLocal.Native' -or
            $type.Assembly.ImageRuntimeVersion -cne 'v4.0.30319') { throw 'WORKSPACE_LOCAL_ASSEMBLY_VERSION_REJECTED' }
    }
}

# Composition only: the existing tray owns this object and its lifetime.
function New-McpCcWorkspaceLocalOwner {
    param([Parameter(Mandatory=$true)][string]$RuntimeRoot, $Manifest)
    Initialize-McpCcWorkspaceLocalNative -Manifest $Manifest
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
