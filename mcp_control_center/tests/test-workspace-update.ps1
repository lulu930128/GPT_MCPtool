Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$source=Get-Content -LiteralPath (Join-Path $root 'src/WorkspaceLocal.Native.cs') -Raw -Encoding UTF8
$fixture=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'WorkspaceUpdate.Check.cs') -Raw -Encoding UTF8
Add-Type -TypeDefinition ($source+"`n"+$fixture) -ReferencedAssemblies System.Web.Extensions,System.Core
$temp=Join-Path ([IO.Path]::GetTempPath()) ('workspace-update-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($temp)
$checks=[McpCc.WorkspaceLocal.UpdateFixture]::Run($temp)
# Exercise the real dispatcher catch using an actual Process.Start failure.
# Its durable pin was written by an earlier invocation, not this stale object.
$module=Import-Module (Join-Path $root 'src/McpControlCenter.WorkspaceUpdate.psm1') -PassThru -Force
$owner=[McpCc.WorkspaceLocal.UpdateFixture]::Open((Join-Path $temp 'launch'))
try{
    $id=[guid]::NewGuid().ToString();$request=[McpCc.WorkspaceLocal.UpdateFixture]::Queue($owner,$id)
    $owner.CompleteUpdate($id,'RUNNING','CC_BOOTSTRAP_PENDING',$null,$null,$null,$null,('b'*64))
    $request=[McpCc.WorkspaceLocal.UpdateFixture]::Replay($owner,$id)
    & $module {
        function script:Get-McpCcUpdateDefinition {param($Workspace,$Id) [pscustomobject]@{root=$Workspace}}
        function script:Start-McpCcBootstrapProcess {param($Info) $Info.FileName='C:\__missing_cc_bootstrap_fixture__\powershell.exe';[void][Diagnostics.Process]::Start($Info)}
    }
    Invoke-McpCcWorkspaceUpdate $owner $request ([pscustomobject]@{codeDeployment=@{workspaceRoot=(Split-Path -Parent $root)}}) (Join-Path $temp 'launch')
    $after=$owner.ReadUpdate($id)
    if($after.phase -ne 'RECOVERY_REQUIRED' -or $after.preparedBuildId -cne ('b'*64)){throw 'FAIL: real launch failure lost recovery/pin'};$checks++
    if($null -ne $after.selectedVersion -or $null -ne $after.observedVersion -or $null -ne $after.observedBuildId){throw 'FAIL: PowerShell null identities violate strict v2 wire schema'};$checks++
    $retry=[McpCc.WorkspaceLocal.UpdateFixture]::Replay($owner,$id)
    if(-not $retry -or $retry.phase -ne 'RECOVERY_REQUIRED'){throw 'FAIL: same owner cannot resume failed launch'};$checks++
    # A busy/alive bootstrap returns progress and performs no deployment action.
    & $module {function script:Start-McpCcBootstrapProcess {param($Info) }}
    Invoke-McpCcWorkspaceUpdate $owner $retry ([pscustomobject]@{codeDeployment=@{workspaceRoot=(Split-Path -Parent $root)}}) (Join-Path $temp 'launch')
    if($owner.ReadUpdate($id).phase -ne 'RUNNING'){throw 'FAIL: bootstrap progress changed to rejection'};$checks++
}finally{$owner.Dispose();Remove-Module $module}
[pscustomobject]@{ok=$true;checks=$checks;evidence='ISOLATED_NATIVE_UPDATE_ADMISSION_AND_RECOVERY';productionPipe=$false}|ConvertTo-Json -Compress
