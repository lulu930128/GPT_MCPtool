<# One-time retirement repair for the exact installed predecessor. Default: inspect.
   -Apply must be run by the original user in Administrator Windows PowerShell.
   No process termination, credential IO, state/Startup/ACL edits or deployment retry.
#>
[CmdletBinding()]
param([switch]$Apply)
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$legacy='C:\Program Files\McpCcReleases\normal-direct-bearer-20261023'
$modulePin='feed3c6b58b3ff19e1d5ee92ccf276745282f5e6dab5739f134783a46e86a4d1'
$manifestPin='468df2bda062595b8a4b3b5831319bbe1481d9257369519d110a4f8ce6f2e691'
$backup='C:\Program Files\McpCcReleases\maintenance\legacy-tunnel-verifier-20261025'
$utf8=New-Object Text.UTF8Encoding($false,$true)

function Get-RepairHash([byte[]]$Bytes) {
    $sha=[Security.Cryptography.SHA256]::Create()
    try{return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
}
function New-RepairedModuleBytes([byte[]]$Bytes) {
    $text=$utf8.GetString($Bytes)
    $before='$command=if($Role -eq ''server''){''"''+$Context.nodePath+''" "''+$Context.httpEntry+''"''}else{''"''+$Context.tunnelClientPath+''" run --profile-dir "''+$Context.tunnelProfileDir+''" --profile "codex-bridge" --log.file "''+$Context.tunnelLogFile+''" --pid.file "''+$Context.tunnelPidFile+''"''}'
    $after='$command=if($Role -eq ''server''){''"''+$Context.nodePath+''" "''+$Context.httpEntry+''"''}else{''"''+$Context.tunnelClientPath+''" ''+(Get-CbTunnelArguments $Context)}'
    if([regex]::Matches($text,[regex]::Escape($before)).Count -ne 1){throw 'LEGACY_REPAIR_SOURCE_CHANGED'}
    $patched=$text.Replace($before,$after)
    $tokens=$null;$errors=$null
    [void][Management.Automation.Language.Parser]::ParseInput($patched,[ref]$tokens,[ref]$errors)
    if($errors.Count){throw 'LEGACY_REPAIR_PARSE_FAILED'}
    return ,$utf8.GetBytes($patched)
}
function New-RepairedManifestBytes([byte[]]$Bytes,[string]$TreeHash) {
    if($TreeHash -cnotmatch '^[0-9a-f]{64}$'){throw 'LEGACY_REPAIR_TREE_HASH_INVALID'}
    $text=$utf8.GetString($Bytes);$document=$text.TrimStart([char]0xfeff)|ConvertFrom-Json
    $old=[string]$document.treeHashes.codex_bridge
    if($old -cnotmatch '^[0-9a-f]{64}$'){throw 'LEGACY_REPAIR_MANIFEST_INVALID'}
    $pattern='("codex_bridge"\s*:\s*")'+[regex]::Escape($old)+'(")'
    if([regex]::Matches($text,$pattern).Count -ne 1){throw 'LEGACY_REPAIR_MANIFEST_AMBIGUOUS'}
    $patched=[regex]::Replace($text,$pattern,('${1}'+$TreeHash+'${2}'))
    $after=$patched.TrimStart([char]0xfeff)|ConvertFrom-Json
    $after.treeHashes.codex_bridge=$old
    if(($document|ConvertTo-Json -Depth 24 -Compress) -cne ($after|ConvertTo-Json -Depth 24 -Compress)){throw 'LEGACY_REPAIR_MANIFEST_SCOPE_CHANGED'}
    return ,$utf8.GetBytes($patched)
}
function Get-LegacyRepairBridgeHash {
    & $verifier {param($p) Get-McpCcInstalledTreeHash $p} (Join-Path $legacy 'codex_bridge')
}
function Assert-LegacyRepairClosure {
    $fresh=Read-McpCcInstalledRelease (Join-Path $legacy 'mcp_control_center')
    Assert-McpCcInstalledClosure $fresh
}
function Write-RepairNew([string]$Path,[byte[]]$Bytes) {
    $stream=[IO.File]::Open($Path,'CreateNew','Write','None')
    try{$stream.Write($Bytes,0,$Bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Write-RepairExisting([string]$Path,[byte[]]$Bytes) {
    # Existing file handles preserve the protected file's ACL/owner.
    $stream=[IO.File]::Open($Path,'Open','Write','None')
    try{$stream.SetLength(0);$stream.Write($Bytes,0,$Bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Invoke-LegacyRepairTransaction([string]$ModulePath,[string]$ManifestPath,[string]$BackupDirectory) {
    $originalModule=[IO.File]::ReadAllBytes($ModulePath);$originalManifest=[IO.File]::ReadAllBytes($ManifestPath)
    if((Get-RepairHash $originalModule) -cne $modulePin -or (Get-RepairHash $originalManifest) -cne $manifestPin){throw 'LEGACY_REPAIR_BASELINE_CHANGED'}
    $moduleAcl=(Get-Acl -LiteralPath $ModulePath).Sddl;$manifestAcl=(Get-Acl -LiteralPath $ManifestPath).Sddl
    $newModule=New-RepairedModuleBytes $originalModule
    Write-RepairNew (Join-Path $BackupDirectory 'codex-bridge-runtime.before.psm1') $originalModule
    Write-RepairNew (Join-Path $BackupDirectory 'installed-release.before.json') $originalManifest
    # Recheck after backup, before the first mutation.
    if((Get-RepairHash ([IO.File]::ReadAllBytes($ModulePath))) -cne $modulePin -or
        (Get-RepairHash ([IO.File]::ReadAllBytes($ManifestPath))) -cne $manifestPin){throw 'LEGACY_REPAIR_BASELINE_CHANGED'}
    $newManifest=$null;$writing=$false
    try {
        $writing=$true;Write-RepairExisting $ModulePath $newModule
        $newManifest=New-RepairedManifestBytes $originalManifest (Get-LegacyRepairBridgeHash)
        Write-RepairExisting $ManifestPath $newManifest
        if((Get-RepairHash ([IO.File]::ReadAllBytes($ModulePath))) -cne (Get-RepairHash $newModule) -or
            (Get-RepairHash ([IO.File]::ReadAllBytes($ManifestPath))) -cne (Get-RepairHash $newManifest) -or
            (Get-Acl -LiteralPath $ModulePath).Sddl -cne $moduleAcl -or (Get-Acl -LiteralPath $ManifestPath).Sddl -cne $manifestAcl){throw 'LEGACY_REPAIR_VERIFY_FAILED'}
        Assert-LegacyRepairClosure
        return @{phase='REPAIRED';moduleSha256=(Get-RepairHash $newModule);manifestSha256=(Get-RepairHash $newManifest);backup=$BackupDirectory;runtimeRestarted=$false;stateChanged=$false;startupChanged=$false;aclChanged=$false}
    }catch {
        if($writing){
            # Do not overwrite an external change or claim recovery after a partial write.
            $nowModule=Get-RepairHash ([IO.File]::ReadAllBytes($ModulePath));$nowManifest=Get-RepairHash ([IO.File]::ReadAllBytes($ManifestPath))
            $allowedManifest=@($manifestPin);if($null -ne $newManifest){$allowedManifest+=Get-RepairHash $newManifest}
            if($nowModule -cne (Get-RepairHash $newModule) -or $nowManifest -cnotin $allowedManifest){throw 'LEGACY_REPAIR_UNKNOWN_DO_NOT_RETRY'}
            Write-RepairExisting $ModulePath $originalModule;Write-RepairExisting $ManifestPath $originalManifest
            Assert-LegacyRepairClosure
            throw 'LEGACY_REPAIR_ROLLED_BACK_INSPECT_BACKUP'
        }
        throw
    }
}

$mutex=$null;$held=$false;$recordCreated=$false
try {
    if((Get-Process -Id $PID).Path -ine 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'){throw 'LEGACY_REPAIR_WINDOWS_POWERSHELL_REQUIRED'}
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    if($Apply -and -not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'LEGACY_REPAIR_ADMIN_REQUIRED'}
    $modulePath=Join-Path $legacy 'codex_bridge\scripts\codex-bridge-runtime.psm1'
    $manifestPath=Join-Path $legacy 'mcp_control_center\config\installed-release.json'
    $verifierPath=Join-Path $legacy 'mcp_control_center\src\McpControlCenter.InstalledRelease.psm1'
    # Reuse the original protected-code path check before executing installed code.
    $guard=Import-Module (Join-Path $PSScriptRoot 'codex-bridge-runtime.psm1') -PassThru -Force
    & $guard {param($p) Assert-CbInstalledAuthorityPath $p} $verifierPath
    $verifier=Import-Module $verifierPath -PassThru -Force
    $release=Read-McpCcInstalledRelease (Join-Path $legacy 'mcp_control_center')
    if($release.state.operatorSid -cne $identity.User.Value){throw 'LEGACY_REPAIR_ORIGINAL_USER_REQUIRED'}
    Assert-LegacyRepairClosure
    if((Get-FileHash -LiteralPath $modulePath).Hash.ToLowerInvariant() -cne $modulePin -or
        (Get-FileHash -LiteralPath $manifestPath).Hash.ToLowerInvariant() -cne $manifestPin){throw 'LEGACY_REPAIR_BASELINE_CHANGED'}
    $null=New-RepairedModuleBytes ([IO.File]::ReadAllBytes($modulePath))
    if(-not $Apply){@{phase='VERIFIED_NOT_APPLIED';requires='Original user, Administrator Windows PowerShell';moduleSha256=$modulePin;manifestSha256=$manifestPin;runtimeChanged=$false}|ConvertTo-Json;exit 0}
    & $guard {param($p) Assert-CbInstalledAuthorityPath $p} (Split-Path -Parent (Split-Path -Parent $backup))
    $maintenance=Split-Path -Parent $backup
    if(Test-Path -LiteralPath $maintenance){& $guard {param($p) Assert-CbInstalledAuthorityPath $p} $maintenance}
    if(Test-Path -LiteralPath $backup){throw 'LEGACY_REPAIR_RECORD_EXISTS_DO_NOT_RETRY'}
    $mutex=New-Object Threading.Mutex($false,'Local\CodexBridgeMcpRuntimeControl')
    try{$held=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{throw 'LEGACY_REPAIR_OWNER_UNKNOWN'}
    if(-not $held){throw 'ACTION_BUSY'}
    $health=Invoke-RestMethod -Uri 'http://127.0.0.1:18828/health' -TimeoutSec 5
    if($health.service -cne 'codex-handoff-bridge' -or $health.jobs.scope -cne 'all' -or $health.jobs.active -ne 0 -or
        $health.jobs.awaitingApproval -ne 0 -or $health.controller -notin @('ready','idle')){throw 'ACTIVE_WORK_PRESENT'}
    [void][IO.Directory]::CreateDirectory($backup);$recordCreated=$true
    & $guard {param($p) Assert-CbInstalledAuthorityPath $p} $backup
    Write-RepairNew (Join-Path $backup 'intent.json') ($utf8.GetBytes((@{phase='REPAIRING';moduleSha256=$modulePin;manifestSha256=$manifestPin;utc=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json)))
    $result=Invoke-LegacyRepairTransaction $modulePath $manifestPath $backup
    Write-RepairNew (Join-Path $backup 'terminal.json') ($utf8.GetBytes(($result|ConvertTo-Json)))
    $result|ConvertTo-Json
}catch {
    $code=([string]$_.Exception.Message -split ':')[0]
    if($code -cnotmatch '^[A-Z][A-Z0-9_]+$'){$code='LEGACY_REPAIR_FAILED_INSPECT_NO_RETRY'}
    if($recordCreated -and -not(Test-Path -LiteralPath (Join-Path $backup 'terminal.json'))){
        Write-RepairNew (Join-Path $backup 'terminal.json') ($utf8.GetBytes((@{phase='BLOCKED';code=$code;automaticRetry=$false}|ConvertTo-Json)))
    }
    @{phase='BLOCKED';code=$code;automaticRetry=$false}|ConvertTo-Json;exit 1
}finally{if($held){$mutex.ReleaseMutex()};if($mutex){$mutex.Dispose()}}
