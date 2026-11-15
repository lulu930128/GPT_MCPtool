# A finite client of the already deployed CC owner. Never launches a worker.
param(
    [Parameter(Mandatory=$true)][ValidateSet('Status','ApplyUpdate','Receipt')][string]$Action,
    [string]$RequestId='',
    [string]$ExpectedSourceDigest=''
)
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
function Import-McpCcOmiClientNative([string]$NativePath) {
    # NORMAL may omit TEMP/TMP. Use only the existing current user's Temp;
    # never let CodeDOM fall back to the working directory or C:\Windows.
    try {
        $local=[Environment]::GetFolderPath('LocalApplicationData')
        if(-not $local -or $local.StartsWith('\\')){throw 'OMI_CLIENT_USER_TEMP_UNVERIFIED'}
        $userTemp=[IO.Path]::GetFullPath((Join-Path $local 'Temp'))
        if(-not [IO.Directory]::Exists($userTemp)){throw 'OMI_CLIENT_USER_TEMP_UNVERIFIED'}
        for($p=$userTemp;$p;$p=[IO.Path]::GetDirectoryName($p)) {
            if((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'OMI_CLIENT_USER_TEMP_UNVERIFIED'}
        }
        $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
        if((Get-Acl -LiteralPath $userTemp).GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $sid.Value){throw 'OMI_CLIENT_USER_TEMP_UNVERIFIED'}
    }catch{throw 'OMI_CLIENT_USER_TEMP_UNVERIFIED'}
    $oldTemp=[Environment]::GetEnvironmentVariable('TEMP','Process')
    $oldTmp=[Environment]::GetEnvironmentVariable('TMP','Process')
    try {
        [Environment]::SetEnvironmentVariable('TEMP',$userTemp,'Process')
        [Environment]::SetEnvironmentVariable('TMP',$userTemp,'Process')
        Add-Type -Path $NativePath -ReferencedAssemblies System.Web.Extensions,System.Core -ErrorAction Stop
    }catch{throw 'OMI_CLIENT_COMPILE_UNAVAILABLE'}
    finally {
        [Environment]::SetEnvironmentVariable('TEMP',$oldTemp,'Process')
        [Environment]::SetEnvironmentVariable('TMP',$oldTmp,'Process')
    }
}
try {
    $source='C:\GPT_MCPtool\mcp_control_center'
    Import-Module (Join-Path $source 'src/McpControlCenter.Deployment.psm1')
    $selector=Get-Content -LiteralPath (Join-Path $source 'Runtime/current.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if($selector.contract -cne 'mcpcc-current-v1'){throw 'CC_SELECTOR_UNVERIFIED'}
    $layout=Test-McpCcDeploymentVersion (Join-Path $source 'Runtime') $selector.version
    # Compile only the selected inventory-verified native code. Old deployments
    # fail closed; the client cannot activate new source by itself.
    Import-McpCcOmiClientNative (Join-Path $layout.managerRoot 'src/WorkspaceLocal.Native.cs')
    if(-not ('McpCc.WorkspaceLocal.OmiClient' -as [type])){throw 'OMI_CAPABILITY_NOT_DEPLOYED'}
    $ownerPid=[int](Get-Content -LiteralPath (Join-Path $source '.local/runtime/tray.pid') -Raw)
    $rows=@(Get-CimInstance Win32_Process -Filter ('ProcessId='+$ownerPid) -OperationTimeoutSec 3)
    $tray=Join-Path $layout.managerRoot 'scripts/tray.ps1'
    $exe=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    if($rows.Count -ne 1 -or $rows[0].ExecutablePath -ine $exe -or
        $rows[0].CommandLine -notmatch ('(?i)\s-File\s+"'+[regex]::Escape($tray)+'"(?:\s|$)')){throw 'CC_DEPLOYED_OWNER_UNVERIFIED'}
    $owner=Get-Process -Id $ownerPid
    try {
        $ticks=$owner.StartTime.ToUniversalTime().Ticks
        if([Math]::Abs($rows[0].CreationDate.ToUniversalTime().Ticks-$ticks) -ge 10){throw 'CC_OWNER_CHANGED'}
        $op=switch($Action){'Status'{'omi_status'}'Receipt'{'omi_receipt'}'ApplyUpdate'{'omi_apply'}}
        $reply=[McpCc.WorkspaceLocal.OmiClient]::Call($op,$RequestId,$ExpectedSourceDigest,$ownerPid,$ticks)
        $reply
        $r=$reply|ConvertFrom-Json
        if($r.code -cnotin @('OMI_CAPABILITY_OBSERVED','OMI_APPLY_QUEUED','REQUEST_REPLAY','RECEIPT_OBSERVED')){exit 2}
        exit 0
    } finally {$owner.Dispose()}
} catch {
    $code=($_.Exception.Message -split ':')[0]
    if($code -cnotmatch '^[A-Z][A-Z0-9_]{0,95}$'){$code='OMI_CLIENT_UNVERIFIED_CHECK_ORIGINAL_RECEIPT'}
    [ordered]@{contract='cc-omi-launcher-update-v1';code=$code;requestId=$RequestId;available=$false;replayed=$false}|ConvertTo-Json -Compress
    exit 2
}
