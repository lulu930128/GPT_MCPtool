# Shared by the existing owner/controller and source updater. Never reads journal data.
function Initialize-CbDailyNative {
    if(-not ('CbDailyLockFile' -as [type])){Add-Type -Path (Join-Path $PSScriptRoot 'DailyLifecycle.Native.cs')}
}
function Open-CbDailyMutation($Context) {
    $layout=Get-CbCooperativeDailyLayout $Context.projectRoot
    if($null -eq $layout){return $null}
    $root=Join-Path $layout.workspaceRoot 'codex_bridge\Runtime'
    $path=Join-Path $root 'update.lock'
    Assert-CbCooperativeCodePath $path
    if($env:CB_DAILY_PARENT_PID){
        # No public bypass switch: require actual OS ancestry and duplicate the
        # parent's retained exclusive file object. A JSON flag/PID alone is not a lease.
        Initialize-CbDailyNative
        $parentId=0;$ticks=0L;$raw=0L
        if(-not[int]::TryParse($env:CB_DAILY_PARENT_PID,[ref]$parentId) -or
            -not[long]::TryParse($env:CB_DAILY_PARENT_TICKS,[ref]$ticks) -or
            -not[long]::TryParse($env:CB_DAILY_LOCK_HANDLE,[ref]$raw)){throw 'DAILY_DELEGATION_REJECTED'}
        $self=Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID) -ErrorAction Stop
        $ancestor=Get-CimInstance Win32_Process -Filter ('ProcessId='+$self.ParentProcessId) -ErrorAction Stop
        if($ancestor -and $ancestor.ProcessId -ne $parentId){
            # daily owner -> runtime-control is the only extra hop.
            if($ancestor.ExecutablePath -ine 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -or
                $ancestor.CommandLine -notmatch '(?i)-File\s+"?[^"\r\n]+\\daily-code-owner\.ps1"?\s'){throw 'DAILY_DELEGATION_REJECTED'}
            $ancestor=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ancestor.ParentProcessId) -ErrorAction Stop
        }
        if(-not $ancestor -or $ancestor.ProcessId -ne $parentId -or
            -not [CbDailyLockFile]::SameProcessStart($ancestor.CreationDate.ToUniversalTime().Ticks,$ticks) -or
            $ancestor.ExecutablePath -ine 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'){throw 'DAILY_DELEGATION_REJECTED'}
        $copy=[CbDailyLockFile]::DuplicateUpdateLock($parentId,$raw,$path)
        $timeout=170000
        $fixtureTimeout=Get-Variable -Name CbDailyHelperLeaseTimeoutMs -Scope Script -ErrorAction SilentlyContinue
        if($fixtureTimeout){$timeout=[int]$fixtureTimeout.Value}
        try {return [CbDailyLease]::new($copy,$parentId,$timeout)}catch{$copy.Dispose();throw}
    }
    try {return [IO.File]::Open($path,'OpenOrCreate','ReadWrite','None')}
    catch [IO.IOException] {throw 'DAILY_UPDATE_BUSY: A daily transaction still holds update.lock.'}
}
function Assert-CbDailySelected($Context) {
    $layout=Get-CbCooperativeDailyLayout $Context.projectRoot
    if($null -eq $layout -or $env:CB_DAILY_PARENT_PID){return}
    $current=Read-CbCooperativeCodeJson (Join-Path $layout.workspaceRoot 'codex_bridge\Runtime\current.json')
    if($current.contract -cne 'mcpcc-daily-current-v1' -or
        $current.version -cne (Split-Path -Leaf (Split-Path -Parent $Context.projectRoot))){throw 'DAILY_SELECTOR_CHANGED: Resolve the current controller again.'}
}
function Get-CbDailyObservation($Context) {
    $roles=@{}
    foreach($role in @('server','tunnel')){
        $o=Resolve-CbRoleOwnership -Context $Context -Role $role -ReadOnly
        $process=if($o.pid){Get-CbProcess -ProcessId $o.pid}else{$null}
        $roles[$role]=@{state=$o.state;canMutate=$o.canMutate;pid=$o.pid;
            startedUtc=$(if($process){$process.StartTimeUtc}else{$null});image=$(if($process){$process.ExecutablePath}else{$null})}
    }
    $health=Get-CbHealth $Context
    return @{roles=$roles;coreReady=(Test-CbServerHealth $Context);buildId=$(if($health){$health.buildId}else{$null});
        expectedBuildId=(Get-CbExpectedBuildId $Context);version=(Split-Path -Leaf (Split-Path -Parent $Context.projectRoot));
        lockPresent=(Test-Path -LiteralPath (Join-Path $Context.dataDir 'powershell-approval\approval.lock'))}
}
function Assert-CbDailyCoreAbsent($Context) {
    $o=Resolve-CbRoleOwnership -Context $Context -Role server -ReadOnly
    if(-not $o.canMutate -or $o.state -cne 'Stopped'){throw 'DAILY_CORE_STILL_PRESENT'}
    # Also catch a process not yet listening or absent from stale PID metadata.
    $layout=Get-CbCooperativeDailyLayout $Context.projectRoot
    $componentRoot=if($layout){Join-Path $layout.workspaceRoot 'codex_bridge'}else{$Context.projectRoot}
    $entryPattern='(?i)'+[regex]::Escape($componentRoot)+'[\\/](?:Runtime[\\/]versions[\\/][a-z0-9_-]+[\\/]codex_bridge[\\/])?dist[\\/]src[\\/]http-main\.js'
    foreach($p in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop)){
        if($p.ExecutablePath -ieq $Context.nodePath -and [string]::IsNullOrWhiteSpace($p.CommandLine)){throw 'DAILY_CORE_IDENTITY_UNKNOWN'}
        if($p.CommandLine -match $entryPattern){throw 'DAILY_CORE_STILL_PRESENT'}
        # A different checkout is independent unless its explicit command line
        # claims this data directory. Do not infer ownership from its basename.
        if($p.CommandLine -match '(?i)http-main\.js' -and $p.CommandLine.IndexOf($Context.dataDir,[StringComparison]::OrdinalIgnoreCase) -ge 0){throw 'DAILY_CORE_STILL_PRESENT'}
    }
}
function Assert-CbDailyLockOwnerExited($Record) {
    if($null -eq $Record){return}
    $identity=$Record.PSObject.Properties['identity']
    if($null -eq $identity -or $null -eq $identity.Value){return}
    $identity=$identity.Value;$pidField=$identity.PSObject.Properties['pid']
    if($null -eq $pidField){return}
    $ownerId=0
    if(-not[int]::TryParse([string]$pidField.Value,[ref]$ownerId) -or $ownerId -le 0){return}
    $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ownerId) -ErrorAction Stop
    if(-not $p){return}
    $time=$identity.PSObject.Properties['startedUtcTicks'];$ticks=0L
    if($null -eq $time -or -not[long]::TryParse([string]$time.Value,[ref]$ticks) -or $ticks -le 0 -or $null -eq $p.CreationDate){throw 'DAILY_LOCK_OWNER_PRESENT_OR_UNKNOWN'}
    Initialize-CbDailyNative
    if([CbDailyLockFile]::SameProcessStart($p.CreationDate.ToUniversalTime().Ticks,$ticks)){throw 'DAILY_LOCK_OWNER_PRESENT'}
    # A different creation time proves PID reuse, not a living original owner.
}
function Move-CbDailyApprovalLock($Context,[string]$Operation) {
    Assert-CbDailyCoreAbsent $Context
    $path=Join-Path $Context.dataDir 'powershell-approval\approval.lock'
    if(-not(Test-Path -LiteralPath $path)){return @{phase='ABSENT';journalRead=$false;journalChanged=$false}}
    Assert-CbCooperativeCodePath $path;Assert-CbCooperativeCodePath $Operation
    if((Split-Path -Leaf $Operation) -cnotmatch '^[0-9a-f]{32}$'){throw 'DAILY_OPERATION_INVALID'}
    Initialize-CbDailyNative
    $snapshot=[CbDailyLockFile]::Open($path,$false)
    try {$identity=$snapshot.Identity;$hash=$snapshot.Sha256}finally{$snapshot.Dispose()}
    $locked=[CbDailyLockFile]::Open($path,$true)
    try {
        if($locked.Identity -cne $identity -or $locked.Sha256 -cne $hash){throw 'DAILY_LOCK_CHANGED'}
        $record=$null
        try {if($locked.MetadataDecoded -and $locked.Text.Trim()){$record=$locked.Text|ConvertFrom-Json}}catch{}
        Assert-CbDailyLockOwnerExited $record
        Assert-CbDailyCoreAbsent $Context
        $backup=$path+'.retired-'+[guid]::NewGuid().ToString('N')
        $receipt=@{phase='RETIRING';fileIdentity=$identity;sha256=$hash;backup=$backup;utc=[DateTime]::UtcNow.ToString('o');journalRead=$false;journalChanged=$false}
        $receiptPath=Join-Path $Operation ('lock-retire-'+[guid]::NewGuid().ToString('N')+'.json')
        $bytes=[Text.Encoding]::UTF8.GetBytes(($receipt|ConvertTo-Json -Compress))
        $f=[IO.File]::Open($receiptPath,'CreateNew','Write','None')
        try {$f.Write($bytes,0,$bytes.Length);$f.Flush($true)}finally{$f.Dispose()}
        $locked.Retire($backup,$identity,$hash)
        $receipt.phase='RETIRED'
        return $receipt
    } finally {$locked.Dispose()}
}
function Complete-CbDailyStopped($Context,[string]$Operation) {
    Assert-CbDailyCoreAbsent $Context
    $tunnel=Resolve-CbRoleOwnership -Context $Context -Role tunnel -ReadOnly
    if(-not $tunnel.canMutate){throw 'DAILY_TUNNEL_OWNERSHIP_UNKNOWN'}
    if($tunnel.state -cne 'Stopped'){
        # Recovery has no retained core handle from the interrupted process.
        # Re-attest absence and retain the EXACT owned tunnel instance instead.
        $handle=Open-CbOwnedProcess -ProcessId $tunnel.pid
        try {
            if($handle.HasExited -or -not(Test-CbExecutableIdentity $Context tunnel $handle) -or
                -not(Test-CbOwnerMetadata $Context tunnel $handle)){throw 'OWNERSHIP_MISMATCH'}
            Assert-CbDailyCoreAbsent $Context
            $again=Resolve-CbRoleOwnership -Context $Context -Role tunnel -ReadOnly
            if(-not $again.canMutate -or $again.pid -ne $handle.ProcessId){throw 'OWNERSHIP_MISMATCH'}
            $handle.TerminateAndWait()
            Remove-CbRuntimeFile -Path $Context.tunnelPidFile -ExpectedPid $handle.ProcessId
            Remove-CbRuntimeFile -Path $Context.tunnelOwnerFile
        } finally {$handle.Dispose()}
    }
    $lock=Move-CbDailyApprovalLock $Context $Operation
    foreach($role in @('server','tunnel')){
        $o=Resolve-CbRoleOwnership -Context $Context -Role $role -ReadOnly
        if(-not $o.canMutate -or $o.state -cne 'Stopped'){throw 'DAILY_STOP_NOT_CONFIRMED'}
    }
    return @{phase='STOPPED';serverExited=$true;tunnelExited=$true;approvalLock=$lock}
}
