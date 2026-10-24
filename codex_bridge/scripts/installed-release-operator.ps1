param(
    [ValidateSet('Prepare','Install','PlanState','BindState','Preflight','Cutover','Rollback','MigrationPlan','MigrationApply','MigrationVerify','MigrationCleanup','MigrationRollback')][string]$Action='Preflight',
    [switch]$RuntimeMigration,
    [switch]$RecoverR15PreCopy,
    [string]$StatePlanSha256,
    [string]$PreviousReleaseRoot,
    [string]$UpgradeFromReleaseRoot,
    [string]$StateRecoveryReceipt,
    [string]$StateRecoverySha256,
    [switch]$AllowRecoveredSourceAdvance,
    [string]$ReleaseRoot,
    [string]$CandidateRoot,
    [string]$PackageRoot,
    [string]$PackageFile,
    [string]$PackageSha256,
    [string]$ReleaseId,
    [string]$LegacyWorkspaceRoot='C:\GPT_MCPtool',
    [string]$NodeDistribution='C:\Program Files\nodejs',
    [string]$DataDir='C:\CodexBridge',
    [string]$ProjectsFile,
    [string]$CodexHome,
    [switch]$InitializeBridgeBearer
)
# Local, independent operator only. No task/service, elevation or arbitrary command.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$utf8=New-Object Text.UTF8Encoding($false)
$ps='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$manager=Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'mcp_control_center'
$verifier=Import-Module (Join-Path $manager 'src\McpControlCenter.InstalledRelease.psm1') -PassThru
$operator=& $verifier {Get-McpCcInstalledOperator}
. (Join-Path $PSScriptRoot 'bridge-bearer.ps1')

function Assert-IndependentOperator {
    if ((Get-Process -Id $PID).Path -ine $ps) { throw 'WINDOWS_POWERSHELL_REQUIRED' }
    $installed=Test-Path -LiteralPath (Join-Path $manager 'config\installed-release.json')
    $native=Join-Path $manager $(if($installed){'src\RemoteSelfReload.Native.dll'}else{'src\RemoteSelfReload.Native.cs'})
    if($installed){ & $verifier {param($p) Assert-McpCcProtectedCodePath $p} $native }
    if (-not ('McpCcReloadNative' -as [type])) { Add-Type -Path $native }
    if($installed -and [McpCcReloadNative].Assembly.Location -ine $native){throw 'INSTALLED_LOADED_NATIVE_MISMATCH'}
    if (-not [McpCcReloadNative]::OutsideAllJobs()) { throw 'INDEPENDENT_OPERATOR_REQUIRED' }
    $p=Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction Stop
    $seen=@{};$depth=0
    while ($p.ParentProcessId -gt 0) {
        $parent=[int]$p.ParentProcessId
        if ($seen.ContainsKey($parent) -or ++$depth -gt 64) { throw 'OPERATOR_LINEAGE_UNKNOWN' }
        $seen[$parent]=$true
        $p=Get-CimInstance Win32_Process -Filter "ProcessId=$parent" -ErrorAction Stop
        if ($null -eq $p) { throw 'OPERATOR_LINEAGE_UNKNOWN' }
        if ($p.Name -match '^(node|codex|codex-exec)\.exe$' -or $p.CommandLine -match 'app-server') { throw 'INDEPENDENT_OPERATOR_REQUIRED' }
        if ($p.Name -eq 'explorer.exe') { return }
    }
    throw 'OPERATOR_LINEAGE_UNKNOWN'
}
function Read-BoundedJson([string]$Path,[int]$Limit=65536) {
    & $verifier {param($p) Assert-McpCcNoReparseChain $p} $Path
    if ((Get-Item -LiteralPath $Path).Length -gt $Limit) { throw 'DOCUMENT_LIMIT' }
    return [IO.File]::ReadAllText($Path,[Text.Encoding]::UTF8) | ConvertFrom-Json
}
function Write-Receipt([string]$Path,$Document) {
    & $verifier {param($p,$s) Assert-McpCcInstalledPrivatePath $p $s} (Split-Path -Parent $Path) $operator.sid
    if (Test-Path -LiteralPath $Path) { & $verifier {param($p,$s) Assert-McpCcInstalledPrivatePath $p $s} $Path $operator.sid }
    $temporary=$Path+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
    [IO.File]::WriteAllText($temporary,($Document|ConvertTo-Json -Depth 12),$utf8)
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}
function Copy-CodeTree([string]$From,[string]$To) {
    & $verifier {param($p) Assert-McpCcNoReparseChain $p;[void](Get-McpCcInstalledTreeHash $p)} $From
    New-Item -ItemType Directory -Path $To -ErrorAction Stop | Out-Null
    foreach ($entry in Get-ChildItem -LiteralPath $From -Force) { Copy-Item -LiteralPath $entry.FullName -Destination $To -Recurse -ErrorAction Stop }
    # Detect source changes across the copy, including added/removed entries.
    $a=& $verifier {param($p) Get-McpCcInstalledTreeHash $p} $From
    $b=& $verifier {param($p) Get-McpCcInstalledTreeHash $p} $To
    if ($a -cne $b) { throw 'PACKAGE_SOURCE_CHANGED' }
}
function Get-PackageHash([string]$Root) {
    # Root hashing does not exclude the nested release manifest.
    return & $verifier {param($p) Get-McpCcInstalledTreeHash $p} $Root
}
function Resolve-ReleaseArchivePath([string]$Root,[string]$Name,[int]$Attributes) {
    $name=$Name.Replace('\','/')
    if($name -cnotmatch '^(mcp_control_center|codex_bridge|dependencies)/' -or
        $name -match '[:*?"<>|\x00-\x1f]|(^|/)\.{1,2}(/|$)|[ .](/|$)|//' -or
        ($Attributes -band 0x400) -or (($Attributes -shr 16) -band 0xF000) -eq 0xA000){throw 'PACKAGE_ENTRY_INVALID'}
    foreach($part in $name.TrimEnd('/').Split('/')){
        if($part -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)'){throw 'PACKAGE_ENTRY_INVALID'}
    }
    $path=[IO.Path]::GetFullPath((Join-Path $Root $name))
    if(-not $path.StartsWith($Root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'PACKAGE_ENTRY_ESCAPE'}
    return $path
}
function Set-NewDirectoryAcl([string]$Path,[switch]$Code,[string]$ReaderSid=$operator.sid) {
    $acl=New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true,$false)
    $ownerSid=if ($Code) {'S-1-5-32-544'} else {$operator.sid}
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier($ownerSid)))
    foreach ($sid in @('S-1-5-18','S-1-5-32-544',$ReaderSid) | Select-Object -Unique) {
        $rights=if ($Code -and $sid -eq $ReaderSid) {'ReadAndExecute'} else {'FullControl'}
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),$rights,'ContainerInherit,ObjectInherit','None','Allow')))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}
function Get-Health([switch]$Idle) {
    $h=Invoke-RestMethod -Uri 'http://127.0.0.1:18828/health' -TimeoutSec 3 -MaximumRedirection 0
    if ($h.ok -cne $true -or $h.service -cne 'codex-handoff-bridge' -or $h.buildId -cnotmatch '^[0-9a-f]{16}$' -or
        $h.jobs.scope -cne 'all' -or $h.controller -notin @('idle','ready')) { throw 'RUNTIME_UNVERIFIED' }
    if ($Idle -and ($h.jobs.active -cne 0 -or $h.jobs.awaitingApproval -cne 0)) { throw 'ALL_JOBS_MUST_BE_TERMINAL' }
    return $h
}
function Get-ReleaseHttpToken($Release) {
    if($null -eq $Release){return [Environment]::GetEnvironmentVariable('CODEX_BRIDGE_HTTP_TOKEN','Process')}
    # The previous immutable release selects its own auth mode, including rollback.
    if($Release.cutover.httpTokenSha256 -ceq ''){return $null}
    if($Release.schemaVersion -eq 6){return Read-CbPersistedBearer $Release $verifier $Release.cutover.httpTokenSha256}
    $value=[Environment]::GetEnvironmentVariable('CODEX_BRIDGE_HTTP_TOKEN','Process')
    if((& $verifier {param($t) Get-McpCcInstalledTokenHash $t} $value) -cne $Release.cutover.httpTokenSha256){throw 'INSTALLED_HTTP_AUTH_MISMATCH'}
    return $value
}
function Invoke-Controller([string]$Root,[ValidateSet('Status','EnsureRunning','ShutdownRuntime')][string]$Verb) {
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=$ps;$info.Arguments='-NoProfile -NonInteractive -File "'+(Join-Path $Root 'scripts\runtime-control.ps1')+'" -Action '+$Verb
    if($Verb -eq 'ShutdownRuntime' -and -not(Test-Path -LiteralPath (Join-Path $Root '..\mcp_control_center\config\installed-release.json'))){$info.Arguments+=' -RequireAllJobs'}
    $info.WorkingDirectory=$Root;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    # Never inherit loader overrides or arbitrary PATH/PowerShell modules.
    try{$childEnvironment=$info.get_EnvironmentVariables()}catch{
        if($_.Exception.InnerException -isnot [ArgumentException]){throw};$childEnvironment=$info.get_EnvironmentVariables()
    }
    $childEnvironment.Clear()
    foreach ($n in @('USERPROFILE','LOCALAPPDATA','APPDATA','TEMP','TMP','CODEX_BRIDGE_HTTP_TOKEN')) {
        $v=[Environment]::GetEnvironmentVariable($n,'Process');if($null -ne $v){$info.EnvironmentVariables[$n]=$v}
    }
    if(Test-Path -LiteralPath (Join-Path $Root '..\mcp_control_center\config\installed-release.json')){
        $target=Read-McpCcInstalledRelease (Join-Path $Root '..\mcp_control_center')
        Assert-McpCcInstalledClosure $target
        $targetToken=Get-ReleaseHttpToken $target
        $info.EnvironmentVariables.Remove('CODEX_BRIDGE_HTTP_TOKEN')
        if($targetToken){$info.EnvironmentVariables['CODEX_BRIDGE_HTTP_TOKEN']=$targetToken}
        $targetToken=$null
    }
    $info.EnvironmentVariables['SystemRoot']='C:\Windows';$info.EnvironmentVariables['WINDIR']='C:\Windows'
    $info.EnvironmentVariables['PATH']='C:\Windows\System32;C:\Program Files\nodejs'
    # Windows PowerShell 5.1 uses PATHEXT even for an absolute native path.
    # Without it netstat is not invoked and LASTEXITCODE remains unset.
    $info.EnvironmentVariables['PATHEXT']='.COM;.EXE;.BAT;.CMD'
    $info.EnvironmentVariables['PSModulePath']='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
    $p=[Diagnostics.Process]::Start($info)
    try {
        # A detached descendant can retain the redirected handles after the
        # controller exits. Bound both process lifetime and output completion;
        # WaitForExit alone does not bound ReadToEndAsync().Result.
        $clock=[Diagnostics.Stopwatch]::StartNew()
        $stdoutBuffer=New-Object char[] 4096;$stderrBuffer=New-Object char[] 1
        $stdout=$p.StandardOutput.ReadAsync($stdoutBuffer,0,$stdoutBuffer.Length)
        $stderr=$p.StandardError.ReadAsync($stderrBuffer,0,$stderrBuffer.Length)
        $out='';$err='';$stdoutDone=$false;$stderrDone=$false;$exitObservedAt=$null
        while($true){
            if($clock.ElapsedMilliseconds -ge 180000){throw 'CONTROLLER_UNKNOWN_DO_NOT_RETRY'}
            if(-not $stderrDone -and $stderr.IsCompleted){
                $count=$stderr.GetAwaiter().GetResult()
                if($count -gt 0){$err=[string]$stderrBuffer[0];throw 'CONTROLLER_FAILED_DO_NOT_RETRY'}
                $stderrDone=$true
            }
            if(-not $stdoutDone -and $stdout.IsCompleted){
                $count=$stdout.GetAwaiter().GetResult()
                if($count -eq 0){$stdoutDone=$true}else{
                    if($out.Length+$count -gt 65536){throw 'CONTROLLER_FAILED_DO_NOT_RETRY'}
                    $out+=(-join $stdoutBuffer[0..($count-1)])
                    $stdout=$p.StandardOutput.ReadAsync($stdoutBuffer,0,$stdoutBuffer.Length)
                }
            }
            if($p.HasExited){
                if($p.ExitCode -ne 0){throw 'CONTROLLER_FAILED_DO_NOT_RETRY'}
                if($stdoutDone -and $stderrDone){break}
                if($null -eq $exitObservedAt){$exitObservedAt=$clock.ElapsedMilliseconds}
                if($clock.ElapsedMilliseconds-$exitObservedAt -ge 2000){throw 'CONTROLLER_OUTPUT_NOT_CLOSED_DO_NOT_RETRY'}
            }
            Start-Sleep -Milliseconds 10
        }
        if($p.ExitCode -ne 0 -or $out.Length -gt 65536 -or $err.Length -gt 0){throw 'CONTROLLER_FAILED_DO_NOT_RETRY'}
        $result=$out|ConvertFrom-Json
        if($result.ok -cne $true -or $result.action -cne $Verb){throw 'CONTROLLER_UNVERIFIED'}
        return $result
    } finally {$p.Dispose()}
}
function Assert-OwnedReady($Result,$Health) {
    $s=$Result.after
    if($s.status -cne 'Ready' -or $s.canonicalBuildId -cne $Health.buildId -or $s.server.pid -ne $Health.pid -or
        $s.server.ownership -cne 'OwnedReady' -or $s.tunnel.ownership -cne 'OwnedReady' -or
        $s.server.pid -ne $s.server.listenerPid -or $s.tunnel.pid -ne $s.tunnel.listenerPid -or $s.tunnelIdentity.status -cne 'Ready'){throw 'OWNER_UNVERIFIED'}
    foreach($processId in @($s.server.pid,$s.tunnel.pid)){
        $process=Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction Stop
        $sid=Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop
        if($sid.ReturnValue -ne 0 -or $sid.Sid -cne $operator.sid){throw 'CREDENTIAL_OWNER_UNVERIFIED'}
    }
}
function Assert-HttpAuthentication([switch]$MigrationStoreStatus,$Release=$null) {
    $headers=@{Accept='application/json, text/event-stream'}
    $token=Get-ReleaseHttpToken $Release
    if($token){$headers.Authorization='Bearer '+$token}
    # Discovery only, no domain tool or model execution. Session is deleted below.
    $session=$null
    try {
        $r=Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:18828/mcp' -Method Post -Headers $headers -ContentType 'application/json' -TimeoutSec 5 -MaximumRedirection 0 -Body '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"installed-operator","version":"1"}}}'
        $session=$r.Headers['Mcp-Session-Id'];if(-not $session){throw 'HTTP_AUTH_UNVERIFIED'}
        $headers['Mcp-Session-Id']=$session
        $null=Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:18828/mcp' -Method Post -Headers $headers -ContentType 'application/json' -TimeoutSec 5 -MaximumRedirection 0 -Body '{"jsonrpc":"2.0","method":"notifications/initialized"}'
        $r=Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:18828/mcp' -Method Post -Headers $headers -ContentType 'application/json' -TimeoutSec 5 -MaximumRedirection 0 -Body '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
        if($r.RawContentLength -gt 262144){throw 'SCHEMA_LIMIT'}
        $body=[string]$r.Content
        if($body.TrimStart() -match '^(event:|data:)'){
            $data=@($body -split '\r?\n'|Where-Object{$_.StartsWith('data: ')})
            if($data.Count -ne 1){throw 'SCHEMA_UNVERIFIED'};$body=$data[0].Substring(6)
        }
        $tools=@(($body|ConvertFrom-Json).result.tools)
        foreach($op in @('status','preview','request','receipt','challenge','approve')){
            $tool=@($tools|Where-Object{$_.name -ceq ('codex_self_reload_'+$op)})
            if($tool.Count -ne 1){throw 'R1_SIX_TOOLS_MISSING'}
            if($op -in @('challenge','approve') -and (@($tool[0]._meta.ui.visibility) -join ',') -cne 'app'){throw 'R1_TOOL_VISIBILITY_INVALID'}
        }
        if($MigrationStoreStatus){
            $r=Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:18828/mcp' -Method Post -Headers $headers -ContentType 'application/json' -TimeoutSec 5 -MaximumRedirection 0 -Body '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"codex_powershell_status","arguments":{}}}'
            if($r.RawContentLength -gt 65536){throw 'MIGRATION_STATUS_LIMIT'}
            $body=[string]$r.Content
            if($body.TrimStart() -match '^(event:|data:)'){
                $data=@($body -split '\r?\n'|Where-Object{$_.StartsWith('data: ')})
                if($data.Count -ne 1){throw 'MIGRATION_STATUS_UNVERIFIED'};$body=$data[0].Substring(6)
            }
            $response=($body|ConvertFrom-Json).result
            $store=$response.structuredContent.reviewStore.current
            if(($response.PSObject.Properties['isError'] -and $response.isError) -or $store.lifecycle -cne 'OPEN' -or
                $store.owner -cne 'THIS_INSTANCE' -or $store.presence -cne 'PRESENT'){throw 'MIGRATION_STORE_NOT_OPEN'}
        }
        if($token){
            $code=0
            try {$null=Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:18828/mcp' -TimeoutSec 3 -MaximumRedirection 0}catch{if($_.Exception.Response){$code=[int]$_.Exception.Response.StatusCode}}
            if($code -ne 401){throw 'HTTP_AUTH_DOWNGRADE'}
        }
    } finally {
        if($session){try{$null=Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:18828/mcp' -Method Delete -Headers $headers -TimeoutSec 3 -MaximumRedirection 0}catch{}}
        $headers.Clear();$token=$null
    }
}
function Assert-NoTray {
    $m=$null
    try {$m=[Threading.Mutex]::OpenExisting('Local\McpControlCenterTray')}catch [Threading.WaitHandleCannotBeOpenedException]{return}
    finally {if($m){$m.Dispose()}}
    throw 'CLOSE_CONTROL_CENTER_UI_ONLY_THEN_REPEAT'
}
function Assert-RemoteReceiptsTerminal([string]$OwnerRoot) {
    $root=Join-Path $OwnerRoot 'remote-self-reload-r1'
    if(-not(Test-Path -LiteralPath $root)){return}
    & $verifier {param($p,$s) Assert-McpCcInstalledPrivatePath $p $s} $root $operator.sid
    if(Test-Path -LiteralPath (Join-Path $root 'receipts.next')){throw 'R1_RECEIPT_WRITE_UNRESOLVED'}
    $path=Join-Path $root 'receipts.json'
    if(-not(Test-Path -LiteralPath $path)){return}
    & $verifier {param($p,$s) Assert-McpCcInstalledPrivatePath $p $s} $path $operator.sid
    $state=Read-BoundedJson $path 1048576
    $engine=Import-Module (Join-Path $ReleaseRoot 'mcp_control_center\src\McpControlCenter.SelfReload.psm1') -PassThru
    & $engine {
        param($state)
        Assert-R1Fields $state @('contract','receipts')
        if($state.contract -cne 'remote-self-reload-r1' -or @($state.receipts).Count -gt 256){throw 'R1_STORE_UNVERIFIED'}
        $ids=@{};$keys=@{}
        foreach($receipt in $state.receipts){
            Assert-R1Fields $receipt @('requestId','key','previewDigest','ttlSeconds','oldPid','oldBuildId','targetBuildId','expiresAt','nonce','digest','state','code','updatedAt','history','approval','evidence')
            if($receipt.state -cnotin @('completed','failed') -or $receipt.digest -cne (Get-R1Digest (Get-R1Exact $receipt)) -or
                $ids.ContainsKey($receipt.requestId) -or $keys.ContainsKey($receipt.key)){throw 'R1_STORE_UNRESOLVED'}
            $ids[$receipt.requestId]=$true;$keys[$receipt.key]=$true
        }
    } $state
    # Never construct New-R1Engine: its recovery path writes receipts. Policy is not read.
}
function Start-SelectedTray([string]$Root) {
    $saved=[Environment]::GetEnvironmentVariable('CODEX_BRIDGE_HTTP_TOKEN','Process')
    try {
        if(Test-Path -LiteralPath (Join-Path $Root 'config\installed-release.json')){
            $target=Read-McpCcInstalledRelease $Root;Assert-McpCcInstalledClosure $target
            [Environment]::SetEnvironmentVariable('CODEX_BRIDGE_HTTP_TOKEN',(Get-ReleaseHttpToken $target),'Process')
        }
        $p=Start-Process -FilePath $ps -ArgumentList ('-NoProfile -File "'+(Join-Path $Root 'scripts\tray.ps1')+'"') -WorkingDirectory $Root -WindowStyle Hidden -PassThru
        return $p.Id
    } finally {[Environment]::SetEnvironmentVariable('CODEX_BRIDGE_HTTP_TOKEN',$saved,'Process')}
}

function Get-OwnerMigrationPlan($Release) {
    $source=Join-Path $Release.state.localAppData 'McpControlCenter'
    $target=Get-McpCcInstalledStateRoot $Release
    if($Release.schemaVersion -ne 5 -or $target -cne 'C:\McpControlCenter' -or $source -ine (Join-Path $operator.localAppData 'McpControlCenter')){throw 'OWNER_MIGRATION_SCOPE_REJECTED'}
    $sections=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
    $rows=New-Object 'Collections.Generic.List[object]';$queue=New-Object 'Collections.Generic.Stack[string]';$queue.Push($source);$bytes=0L
    while($queue.Count){
        $path=$queue.Pop()
        if($rows.Count -ge 10000){throw 'OWNER_MIGRATION_LIMIT'}
        & $verifier {param($p) Assert-McpCcNoReparseChain $p} $path
        $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
        $acl=Get-Acl -LiteralPath $path -ErrorAction Stop
        # The old ancestors are untrusted. Copying historical state never grants
        # execution authority; the new owner must pass its independent gates.
        $null=& $verifier {param($a,$s,$d) Get-McpCcInstalledPrivateAcl $a $s $d} $acl $operator.sid $item.PSIsContainer
        $relative=if($path -ieq $source){''}else{$path.Substring($source.Length+1)}
        if($relative -ieq ('installed-bridge\'+$Release.releaseId) -or $relative -ieq 'owner-migration.json'){throw 'OWNER_MIGRATION_CONFLICT'}
        $length=0L;$digest=$null
        if($item.PSIsContainer){foreach($child in Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop){$queue.Push($child.FullName)}}
        else{
            $length=$item.Length;$bytes+=$length
            if($length -gt 16777216 -or $bytes -gt 134217728){throw 'OWNER_MIGRATION_LIMIT'}
            $digest=(Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant()
        }
        $rows.Add([pscustomobject][ordered]@{relative=$relative;directory=[bool]$item.PSIsContainer;length=$length;sha256=$digest;acl=$acl.GetSecurityDescriptorSddlForm($sections)})
    }
    $names=[string[]]@($rows|ForEach-Object{$_.relative});[Array]::Sort($names,[StringComparer]::Ordinal)
    $index=@{};foreach($row in $rows){$index[$row.relative]=$row}
    return [pscustomobject][ordered]@{source=$source;target=$target;bytes=$bytes;entries=@($names|ForEach-Object{$index[$_]})}
}
function Copy-OwnerMigrationEntry($Row,[string]$SourceRoot,[string]$TargetRoot) {
    if($Row.relative -isnot [string] -or $Row.relative -match '(^|\\)\.{1,2}(\\|$)|[:/*?"<>|\x00-\x1f]|[ .](\\|$)|\\\\' -or $Row.relative.StartsWith('\')){throw 'OWNER_MIGRATION_PATH_REJECTED'}
    $source=if($Row.relative){Join-Path $SourceRoot $Row.relative}else{$SourceRoot}
    $target=if($Row.relative){Join-Path $TargetRoot $Row.relative}else{$TargetRoot}
    & $verifier {param($p) Assert-McpCcNoReparseChain $p} $source
    $sourceAcl=Get-Acl -LiteralPath $source -ErrorAction Stop
    $sections=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
    if($sourceAcl.GetSecurityDescriptorSddlForm($sections) -cne $Row.acl){throw 'OWNER_SOURCE_ACL_CHANGED'}
    $item=Get-Item -LiteralPath $source -Force -ErrorAction Stop
    if([bool]$item.PSIsContainer -ne $Row.directory){throw 'OWNER_SOURCE_TYPE_CHANGED'}
    & $verifier {param($p,$s) Assert-McpCcInstalledPrivatePath $p $s -IntegrityOnly} (Split-Path -Parent $target) $operator.sid
    $inputStream=$null;$outputStream=$null;$hash=$null
    try{
        if(-not $Row.directory){
            $inputStream=[IO.File]::Open($source,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
            $hash=[Security.Cryptography.SHA256]::Create()
            if($inputStream.Length -ne $Row.length -or $inputStream.Length -gt 16777216 -or
                ([BitConverter]::ToString($hash.ComputeHash($inputStream))).Replace('-','').ToLowerInvariant() -cne $Row.sha256){throw 'OWNER_SOURCE_CONTENT_CHANGED'}
            $inputStream.Position=0
            # Only an empty file is created before its Deny rules are applied.
            $empty=[IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$empty.Dispose()
        }elseif(-not(Test-Path -LiteralPath $target)){New-Item -ItemType Directory -Path $target -ErrorAction Stop|Out-Null}
        & $verifier {param($p) Assert-McpCcNoReparseChain $p} $target
        $destinationAcl=Get-Acl -LiteralPath $target -ErrorAction Stop
        $next=& $verifier {param($a,$s,$d,$old) Get-McpCcInstalledPrivateAcl $a $s $d $old} $destinationAcl $operator.sid $Row.directory $sourceAcl
        $destinationAcl.SetSecurityDescriptorSddlForm($next.GetSecurityDescriptorSddlForm($sections),[Security.AccessControl.AccessControlSections]::Access)
        Set-Acl -LiteralPath $target -AclObject $destinationAcl -ErrorAction Stop
        if(-not(& $verifier {param($a,$b) Test-McpCcInstalledAclWrite $a $b} (Get-Acl -LiteralPath $target) $next)){throw 'OWNER_DESTINATION_ACL_UNVERIFIED'}
        & $verifier {param($p,$s) Assert-McpCcInstalledPrivatePath $p $s} $target $operator.sid
        if(-not $Row.directory){
            $outputStream=[IO.File]::Open($target,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::None)
            if($outputStream.Length -ne 0){throw 'OWNER_DESTINATION_CHANGED'}
            $inputStream.CopyTo($outputStream);$outputStream.Flush($true);$outputStream.Dispose();$outputStream=$null
            if((Get-FileHash -LiteralPath $target).Hash.ToLowerInvariant() -cne $Row.sha256){throw 'OWNER_COPY_UNVERIFIED'}
        }
    }finally{if($outputStream){$outputStream.Dispose()};if($hash){$hash.Dispose()};if($inputStream){$inputStream.Dispose()}}
}
function Assert-OwnerMigrationSourceUnchanged($Release,[string]$RuntimeRoot) {
    if($Release.schemaVersion -notin @(5,6)){return}
    $saved=Read-BoundedJson (Join-Path $RuntimeRoot 'state-acl-before.json') 16777216
    if($saved.PSObject.Properties['ownerReuse'] -and $saved.ownerReuse -and $saved.ownerReuse.contract -ceq 'installed-active-state-reuse-v1'){
        $current=Get-InstalledUpgradeState $Release $saved.ownerReuse.releaseRoot -RequireSelected
        if((Get-StatePlanHash $current) -cne (Get-StatePlanHash $saved.ownerReuse)){throw 'UPGRADE_BASELINE_CHANGED'}
        return
    }
    if($Release.schemaVersion -eq 6){throw 'MIGRATION_USE_MIGRATION_ACTIONS'}
    if((Get-StatePlanHash (Get-OwnerMigrationPlan $Release)) -cne (Get-StatePlanHash $saved.migration)){throw 'LEGACY_OWNER_STATE_CHANGED'}
}
function Test-RecoveredSourceAcl([string]$Before,[string]$After) {
    if($Before -ceq $After){return $true}
    try {
        $old=New-Object Security.AccessControl.RawSecurityDescriptor($Before)
        $new=New-Object Security.AccessControl.RawSecurityDescriptor($After)
        if($old.Owner -ne $new.Owner -or $old.Group -ne $new.Group -or $old.ControlFlags -ne $new.ControlFlags -or
            $null -eq $old.DiscretionaryAcl -or $null -eq $new.DiscretionaryAcl){return $false}
        # Windows may reorder adjacent Deny ACEs when adding another denial.
        # Normalize only contiguous deny runs; never move a deny past an allow.
        $normalize={
            param($Acl)
            $pending=New-Object 'Collections.Generic.List[string]'
            foreach($ace in $Acl){
                $bytes=New-Object byte[] $ace.BinaryLength;$ace.GetBinaryForm($bytes,0)
                $encoded=[Convert]::ToBase64String($bytes)
                if($ace.AceType -eq [Security.AccessControl.AceType]::AccessDenied){$pending.Add($encoded);continue}
                $ordered=$pending.ToArray();[Array]::Sort($ordered,[StringComparer]::Ordinal)
                foreach($deny in $ordered){[pscustomobject]@{bytes=$deny;deny=$true}}
                $pending.Clear()
                [pscustomobject]@{bytes=$encoded;deny=$false}
            }
            $ordered=$pending.ToArray();[Array]::Sort($ordered,[StringComparer]::Ordinal)
            foreach($deny in $ordered){[pscustomobject]@{bytes=$deny;deny=$true}}
        }
        $oldAces=@(& $normalize $old.DiscretionaryAcl)
        $newAces=@(& $normalize $new.DiscretionaryAcl)
        $index=0
        foreach($ace in $newAces){
            $same=($index -lt $oldAces.Count -and $oldAces[$index].bytes -ceq $ace.bytes)
            if($same){$index++}
            elseif(-not $ace.deny){return $false}
        }
        return $index -eq $oldAces.Count
    }catch{return $false}
}
function Get-RecoveredSourceAdvance($Release,$SavedMigration) {
    # Explicit operator opt-in only. Source is still canonical; retain its full
    # snapshot and import new immutable deduplication receipts, never old PIDs.
    Assert-NoTray
    $current=Get-OwnerMigrationPlan $Release
    if($current.source -cne $SavedMigration.source -or $current.target -cne $SavedMigration.target){throw 'SOURCE_ADVANCE_SCOPE_CHANGED'}
    $before=@{};foreach($row in $SavedMigration.entries){$before[$row.relative]=$row}
    $after=@{};foreach($row in $current.entries){$after[$row.relative]=$row}
    $observations=New-Object 'Collections.Generic.List[string]'
    $imports=New-Object 'Collections.Generic.List[object]'
    foreach($name in $before.Keys){
        if($name -ceq 'tray.pid'){continue}
        if(-not $after.ContainsKey($name)){throw 'SOURCE_ADVANCE_ENTRY_REMOVED'}
    }
    foreach($row in $current.entries){
        $name=[string]$row.relative
        if($name -ceq 'tray.pid'){throw 'SOURCE_ADVANCE_TRAY_PRESENT'}
        $prior=$before[$name]
        if($prior){
            if($prior.directory -cne $row.directory -or -not(Test-RecoveredSourceAcl $prior.acl $row.acl)){throw 'SOURCE_ADVANCE_METADATA_CHANGED'}
            if($row.directory -or ($prior.sha256 -ceq $row.sha256 -and $prior.length -eq $row.length)){continue}
        }
        $observable=($name -cmatch '^(state\.json|reconcile-progress\.json|last-actions\\[a-z_]+\.json|events\\\d{4}-\d{2}-\d{2}\.jsonl)$')
        if($observable -and -not $row.directory){$observations.Add($name);continue}
        if(-not $prior -and $row.directory -and $name -ceq 'workspace-local-receipts'){continue}
        if($prior -or $row.directory -or $name -cnotmatch '^workspace-local-receipts\\([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.json$'){
            throw 'SOURCE_ADVANCE_UNSUPPORTED_CHANGE'
        }
        $id=$matches[1]
        $path=Join-Path $current.source $name
        $receipt=Read-BoundedJson $path 4096
        $fields=@('requestId','componentId','action','confirmation','outcome','createdAt','updatedAt')
        if((@($receipt.PSObject.Properties.Name|Sort-Object) -join ',') -cne (@($fields|Sort-Object) -join ',') -or
            $receipt.requestId -cne $id -or $receipt.componentId -cnotin @('codex_bridge','omi_search','japanese_study','memory_core','personal_asset_os','english_study','listening_audio') -or
            $receipt.action -cne 'reload_runtime' -or $receipt.confirmation -cne 'interrupt_current_requests' -or
            $receipt.outcome -cnotin @('COMPLETED','UNKNOWN')){throw 'SOURCE_ADVANCE_RECEIPT_REJECTED'}
        $created=[DateTimeOffset]::MinValue;$updated=[DateTimeOffset]::MinValue
        if(-not [DateTimeOffset]::TryParse($receipt.createdAt,[ref]$created) -or
            -not [DateTimeOffset]::TryParse($receipt.updatedAt,[ref]$updated) -or $updated -lt $created){throw 'SOURCE_ADVANCE_RECEIPT_REJECTED'}
        $target=Join-Path $current.target $name
        if(Test-Path -LiteralPath $target){
            & $verifier {param($p) Assert-McpCcNoReparseChain $p} $target
            if((Get-Item -LiteralPath $target).PSIsContainer -or
                (Get-FileHash -LiteralPath $target).Hash.ToLowerInvariant() -cne $row.sha256){throw 'SOURCE_ADVANCE_RECEIPT_CONFLICT'}
        }
        $imports.Add($row)
    }
    return [pscustomobject][ordered]@{contract='installed-recovered-source-advance-v1';
        migrationSha256=(Get-StatePlanHash $current);observations=@($observations.ToArray()|Sort-Object);
        receiptImports=$imports.ToArray();legacySourceRetained=$true;existingReceiptsOverwritten=$false}
}
function Get-VerifiedStateRecovery($Release,$Previous,[string]$Runtime,[string]$CutoverHash,[string]$RecoveryPath,[string]$RecoveryHash,[string]$CutoverPhase='UNKNOWN',[switch]$AllowSourceAdvance) {
    # The reviewed audit is provenance, not authority. Re-observe the original
    # controller, private state and restored selection before reusing any state.
    if($RecoveryHash -cnotmatch '^[0-9a-f]{64}$' -or -not [IO.Path]::IsPathRooted($RecoveryPath)){throw 'STATE_RECOVERY_INPUT_REJECTED'}
    & $verifier {param($p) Assert-McpCcNoReparseChain $p} $RecoveryPath
    if((Get-FileHash -LiteralPath $RecoveryPath).Hash.ToLowerInvariant() -cne $RecoveryHash){throw 'STATE_RECOVERY_HASH_CHANGED'}
    $audit=Read-BoundedJson $RecoveryPath 4096
    if($audit.contract -cnotin @('r7-selected-source-recovery-v1','r8-output-source-recovery-v1') -or $audit.phase -cne 'SOURCE_RUNTIME_RESTORED' -or
        $audit.selectedRelease -cne $Previous.releaseId -or $audit.originalReceiptSha256 -cne $CutoverHash -or
        $audit.legacyStartupSha256 -cne $Release.cutover.legacyStartupSha256 -or
        (-not $AllowSourceAdvance -and $audit.buildId -cne $Release.cutover.rollbackBuildId) -or $audit.cutoverReplayed -cne $false -or
        $audit.newCorePid -isnot [int] -or $audit.newTunnelPid -isnot [int] -or
        $audit.newCorePid -le 0 -or $audit.newTunnelPid -le 0 -or $audit.newCorePid -eq $audit.newTunnelPid -or
        $audit.selectedStartupSha256 -cnotmatch '^[0-9a-f]{64}$'){throw 'STATE_RECOVERY_RECEIPT_REJECTED'}
    if($audit.contract -ceq 'r7-selected-source-recovery-v1'){
        if($CutoverPhase -cne 'UNKNOWN'){throw 'STATE_RECOVERY_CUTOVER_PHASE_REJECTED'}
    }else{
        # r8's wrapper never completed, so its original SELECTED receipt is kept.
        # Reuse requires the reviewed, separate stop/drain and Source recovery
        # records, plus the same fresh ownership/selection checks below.
        if($CutoverPhase -cne 'SELECTED'){throw 'STATE_RECOVERY_CUTOVER_PHASE_REJECTED'}
        $recoveryDirectory=Split-Path -Parent ([IO.Path]::GetFullPath($RecoveryPath))
        $stopPath=Join-Path $recoveryDirectory 'r8-output-stop.json'
        $repairPath=Join-Path $recoveryDirectory 'r8-connectivity-recovery.json'
        if($audit.stopReceipt -ine $stopPath -or $audit.stopReceiptSha256 -cnotmatch '^[0-9a-f]{64}$' -or
            $audit.repairReceiptSha256 -cnotmatch '^[0-9a-f]{64}$'){throw 'STATE_RECOVERY_STOP_INPUT_REJECTED'}
        foreach($path in @($stopPath,$repairPath)){& $verifier {param($p) Assert-McpCcNoReparseChain $p} $path}
        if((Get-FileHash -LiteralPath $stopPath).Hash.ToLowerInvariant() -cne $audit.stopReceiptSha256 -or
            (Get-FileHash -LiteralPath $repairPath).Hash.ToLowerInvariant() -cne $audit.repairReceiptSha256){throw 'STATE_RECOVERY_STOP_HASH_CHANGED'}
        $stop=Read-BoundedJson $stopPath 4096
        if($stop.contract -cne 'r8-output-stop-v1' -or $stop.phase -cne 'INSTALLED_STOPPED_OUTPUT_DRAINED' -or
            $stop.releaseId -cne $Previous.releaseId -or $stop.buildId -cne $audit.buildId -or
            $stop.originalReceiptSha256 -cne $CutoverHash -or $stop.selectedStartupSha256 -cne $audit.selectedStartupSha256 -or
            $stop.savedStartup -ine $audit.savedStartup -or $stop.repairAfterSha256 -cne $audit.repairReceiptSha256 -or
            $stop.coreExited -isnot [bool] -or $stop.tunnelExited -isnot [bool] -or $stop.handoffExited -isnot [bool] -or
            $stop.startupChanged -isnot [bool] -or
            $stop.coreExited -cne $true -or $stop.tunnelExited -cne $true -or $stop.handoffExited -cne $true -or
            $stop.startupChanged -cne $false -or $stop.repairBeforeSha256 -cnotmatch '^[0-9a-f]{64}$' -or
            $stop.corePid -isnot [int] -or $stop.tunnelPid -isnot [int] -or $stop.handoffPid -isnot [int] -or
            $stop.corePid -le 0 -or $stop.tunnelPid -le 0 -or $stop.handoffPid -le 0 -or
            @(@($stop.corePid,$stop.tunnelPid,$stop.handoffPid)|Select-Object -Unique).Count -ne 3){throw 'STATE_RECOVERY_STOP_RECEIPT_REJECTED'}
        $savedRepair=Join-Path $recoveryDirectory 'r8-connectivity-before-output-recovery.json'
        if($stop.savedRepair -ine $savedRepair){throw 'STATE_RECOVERY_STOP_INPUT_REJECTED'}
        & $verifier {param($p) Assert-McpCcNoReparseChain $p} $savedRepair
        if((Get-FileHash -LiteralPath $savedRepair).Hash.ToLowerInvariant() -cne $stop.repairBeforeSha256){throw 'STATE_RECOVERY_STOP_HASH_CHANGED'}
        foreach($item in @(@{path=$savedRepair;phase='REPAIRING_CONNECTIVITY'},@{path=$repairPath;phase='UNKNOWN'})){
            $repair=Read-BoundedJson $item.path 4096
            if($repair.contract -cne 'r8-selected-connectivity-recovery-v1' -or $repair.phase -cne $item.phase -or
                $repair.releaseId -cne $Previous.releaseId -or $repair.originalReceiptSha256 -cne $CutoverHash -or
                $repair.corePid -ne $stop.corePid -or $repair.buildId -cne $audit.buildId -or
                $repair.coreRestarted -cne $false -or $repair.startupChanged -cne $false -or
                $repair.cutoverReplayed -cne $false -or $repair.originalReceiptChanged -cne $false -or
                ($item.phase -ceq 'UNKNOWN' -and $repair.lastPhase -cne 'REPAIRING_CONNECTIVITY')){throw 'STATE_RECOVERY_REPAIR_RECEIPT_REJECTED'}
        }
    }
    & $verifier {param($p) Assert-McpCcNoReparseChain $p} $audit.savedStartup
    if((Get-FileHash -LiteralPath $audit.savedStartup).Hash.ToLowerInvariant() -cne $audit.selectedStartupSha256 -or
        (Get-FileHash -LiteralPath (Join-Path $Runtime 'legacy-startup.lnk')).Hash.ToLowerInvariant() -cne $audit.legacyStartupSha256){throw 'STATE_RECOVERY_STARTUP_CHANGED'}
    foreach($name in @('codex-bridge-http-server.pid','codex-bridge-http-server.owner.json','tunnel-client.pid','tunnel-client.owner.json')){
        if(Test-Path -LiteralPath (Join-Path $Runtime $name)){throw 'STATE_RECOVERY_INSTALLED_OWNER_PRESENT'}
    }
    Assert-NoTray
    $health=Get-Health -Idle
    $observed=Invoke-Controller (Join-Path $Release.legacyWorkspaceRoot 'codex_bridge') Status
    Assert-OwnedReady $observed $health
    if($AllowSourceAdvance){
        # Historical drain/repair hashes above remain pinned to the historical
        # build. Only fresh canonical ownership proves the new source baseline.
        if($audit.contract -cne 'r8-output-source-recovery-v1' -or
            $audit.buildId -cne $Previous.cutover.rollbackBuildId -or
            $health.buildId -cne $Release.cutover.rollbackBuildId){throw 'SOURCE_ADVANCE_BUILD_REJECTED'}
        $core=Get-Process -Id $health.pid -ErrorAction Stop
        $tunnel=Get-Process -Id $observed.after.tunnel.pid -ErrorAction Stop
        $runtimeObservation=[pscustomobject][ordered]@{corePid=$health.pid;coreStartedUtc=$core.StartTime.ToUniversalTime().ToString('o');
            tunnelPid=$observed.after.tunnel.pid;tunnelStartedUtc=$tunnel.StartTime.ToUniversalTime().ToString('o');buildId=$health.buildId}
    }elseif($health.buildId -cne $audit.buildId -or $health.pid -ne $audit.newCorePid -or
        $observed.after.tunnel.pid -ne $audit.newTunnelPid){throw 'STATE_RECOVERY_RUNTIME_CHANGED'}
    Assert-RemoteReceiptsTerminal (Get-McpCcInstalledStateRoot $Release)
    $result=[pscustomobject][ordered]@{path=[IO.Path]::GetFullPath($RecoveryPath);sha256=$RecoveryHash;
        sourceBuildId=$audit.buildId;sourceCorePid=$audit.newCorePid;sourceTunnelPid=$audit.newTunnelPid}
    if($AllowSourceAdvance){$result|Add-Member NoteProperty currentSource $runtimeObservation}
    return $result
}
function Get-InactiveBoundState($Release,[string]$PreviousRoot,[string]$RecoveryPath='',[string]$RecoveryHash='',[switch]$AllowSourceAdvance) {
    # Reuse never replays Cutover or rewrites previous UNKNOWN/STATE_BOUND bytes.
    if([bool]$RecoveryPath -ne [bool]$RecoveryHash){throw 'STATE_RECOVERY_INPUT_REJECTED'}
    $previous=Read-McpCcInstalledRelease (Join-Path $PreviousRoot 'mcp_control_center')
    Assert-McpCcInstalledClosure $previous
    if($Release.schemaVersion -ne 5 -or $previous.schemaVersion -ne 5 -or $previous.releaseId -ceq $Release.releaseId -or
        $previous.legacyWorkspaceRoot -ine $Release.legacyWorkspaceRoot){throw 'STATE_REUSE_RELEASE_REJECTED'}
    foreach($name in @('operatorSid','userProfile','localAppData','ownerRoot','dataDir','codexHome','projectsFile')){
        if($previous.state.$name -cne $Release.state.$name){throw 'STATE_REUSE_SCOPE_CHANGED'}
    }
    $owner=Get-McpCcInstalledStateRoot $Release
    foreach($path in @($owner,$Release.state.dataDir)){
        & $verifier {param($p,$s) Assert-McpCcInstalledPrivateTree $p $s} $path $operator.sid
    }
    if(Test-Path -LiteralPath (Join-Path $owner 'tray.pid')){throw 'STATE_REUSE_OWNER_PID_PRESENT'}
    $runtime=Join-Path $owner ('installed-bridge\'+$previous.releaseId)
    & $verifier {param($p,$s) Assert-McpCcInstalledStateReceipt $p $s} $runtime $operator.sid
    $receiptPath=Join-Path $runtime 'state-binding.json'
    $receipt=Read-BoundedJson $receiptPath 4096
    $backup=Join-Path $runtime 'state-acl-before.json'
    $plan=Read-BoundedJson $backup 16777216
    if((Get-StatePlanHash $plan) -cne $receipt.planSha256 -or $plan.releaseId -cne $previous.releaseId -or
        -not(Test-InstalledStateManifest $previous $plan.manifestSha256)) {throw 'STATE_REUSE_PLAN_CHANGED'}
    $sourceAdvance=$null
    if($AllowSourceAdvance){
        if(-not $RecoveryPath){throw 'SOURCE_ADVANCE_RECOVERY_REQUIRED'}
        $sourceAdvance=Get-RecoveredSourceAdvance $Release $plan.migration
    }else{Assert-OwnerMigrationSourceUnchanged $previous $runtime}
    $startup=Join-Path ([Environment]::GetFolderPath('Startup')) 'MCP Control Center.lnk'
    if($previous.cutover.legacyStartupSha256 -cne $Release.cutover.legacyStartupSha256 -or
        (Get-FileHash -LiteralPath $startup).Hash.ToLowerInvariant() -cne $Release.cutover.legacyStartupSha256){throw 'STATE_REUSE_STARTUP_SELECTED_OR_CHANGED'}
    $cutover=Join-Path $runtime 'operator-cutover.json';$cutoverHash=$null;$recovery=$null
    if(Test-Path -LiteralPath $cutover){
        $r=Read-BoundedJson $cutover 4096
        $inactivePhase=($r.phase -ceq 'UNKNOWN' -and $r.lastPhase -ceq $(if($RecoveryPath){'SELECTED'}else{'STOPPING_LEGACY'}))
        $selectedRecovery=($RecoveryPath -and $r.phase -ceq 'SELECTED')
        if($r.contract -cne 'mcpcc-installed-cutover-v1' -or $r.releaseId -cne $previous.releaseId -or
            $r.operatorSid -cne $operator.sid -or -not($inactivePhase -or $selectedRecovery) -or
            $null -ne $r.newPid -or $null -ne $r.newBuildId -or $null -ne $r.newTunnelPid){throw 'STATE_REUSE_CUTOVER_NOT_INACTIVE'}
        $cutoverHash=(Get-FileHash -LiteralPath $cutover).Hash.ToLowerInvariant()
        if($RecoveryPath){
            if($null -ne $r.newStartTimeUtc -or $null -ne $r.newTunnelStartTimeUtc){throw 'STATE_REUSE_CUTOVER_NOT_INACTIVE'}
            $recovery=Get-VerifiedStateRecovery $Release $previous $runtime $cutoverHash $RecoveryPath $RecoveryHash $r.phase -AllowSourceAdvance:$AllowSourceAdvance
        }
    }
    if($RecoveryPath -and -not $recovery){throw 'STATE_RECOVERY_CUTOVER_MISSING'}
    $observationalState=$null
    foreach($row in $plan.migration.entries){
        if($row.relative -in @('','tray.pid')){continue}
        $path=[IO.Path]::GetFullPath((Join-Path $owner $row.relative))
        if(-not $path.StartsWith($owner+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'STATE_REUSE_PATH_REJECTED'}
        $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if($recovery -and $row.relative -ceq 'state.json'){
            # Only the CC status projection may have changed while the selected
            # Tray was running. It is retained as data, never a grant or owner proof.
            if($item.PSIsContainer -or $row.directory -or $item.Length -gt 1048576){throw 'STATE_RECOVERY_STATUS_REJECTED'}
            $observationalState=[pscustomobject][ordered]@{relative='state.json';length=$item.Length;sha256=(Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant()}
            continue
        }
        if($item.PSIsContainer -ne $row.directory -or (-not $row.directory -and
            ($item.Length -ne $row.length -or (Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant() -cne $row.sha256))){throw 'STATE_REUSE_ACTIVE_COPY_CHANGED'}
    }
    $result=[pscustomobject][ordered]@{contract='installed-inactive-state-reuse-v1';releaseRoot=$previous.root;releaseId=$previous.releaseId;
        manifestSha256=$plan.manifestSha256;receiptSha256=(Get-FileHash -LiteralPath $receiptPath).Hash.ToLowerInvariant();
        backupSha256=(Get-FileHash -LiteralPath $backup).Hash.ToLowerInvariant();cutoverSha256=$cutoverHash}
    if($recovery){
        if(-not $observationalState){throw 'STATE_RECOVERY_STATUS_MISSING'}
        $result.contract='installed-recovered-state-reuse-v1'
        $result|Add-Member NoteProperty recovery $recovery
        $result|Add-Member NoteProperty retainedStatus $observationalState
    }
    if($sourceAdvance){$result|Add-Member NoteProperty sourceAdvance $sourceAdvance}
    return $result
}
function Assert-InstalledUpgradeSelection($Previous) {
    $startup=Join-Path ([Environment]::GetFolderPath('Startup')) 'MCP Control Center.lnk'
    & $verifier {param($p) Assert-McpCcNoReparseChain $p} $startup
    $shell=New-Object -ComObject WScript.Shell
    try {
        $link=$shell.CreateShortcut($startup)
        if($link.TargetPath -ine $ps -or $link.Arguments -cnotin @(
                ('-NoProfile -File "'+(Join-Path $Previous.root 'mcp_control_center\scripts\tray.ps1')+'" -AutoReconcile'),
                ('-NoProfile -WindowStyle Hidden -File "'+(Join-Path $Previous.root 'mcp_control_center\scripts\tray.ps1')+'" -AutoReconcile')) -or
            $link.WorkingDirectory -ine (Join-Path $Previous.root 'mcp_control_center')){throw 'UPGRADE_STARTUP_NOT_SELECTED'}
    }finally{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)}
    return (Get-FileHash -LiteralPath $startup).Hash.ToLowerInvariant()
}
function Test-InstalledStateManifest($Release,[string]$ExpectedHash) {
    if($ExpectedHash -cnotmatch '^[0-9a-f]{64}$'){return $false}
    if((Get-FileHash -LiteralPath $Release.sourcePath).Hash.ToLowerInvariant() -ceq $ExpectedHash){return $true}
    # A local startup-presentation repair may reseal code in the same release.
    # Keep the original protected manifest as the state-plan anchor; never rewrite
    # historical plans/cutover receipts or treat UNKNOWN as an accepted deployment.
    $baseline=Join-Path (Split-Path -Parent $Release.sourcePath) 'startup-presentation-baseline.json'
    if(-not(Test-Path -LiteralPath $baseline -PathType Leaf)){return $false}
    & $verifier {param($p) Assert-McpCcProtectedCodePath $p} $baseline
    if((Get-FileHash -LiteralPath $baseline).Hash.ToLowerInvariant() -cne $ExpectedHash){return $false}
    $before=Read-BoundedJson $baseline 16384;$after=Read-BoundedJson $Release.sourcePath 16384
    if(-not $before.PSObject.Properties['treeHashes'] -or -not $after.PSObject.Properties['treeHashes']){return $false}
    if($before.treeHashes.dependencies -cne $after.treeHashes.dependencies){return $false}
    $before.PSObject.Properties.Remove('treeHashes');$after.PSObject.Properties.Remove('treeHashes')
    # Everything outside the resealed code trees (identity, private state, pinned
    # native dependencies, authentication and configuration) must remain identical.
    return ($before|ConvertTo-Json -Depth 24 -Compress) -ceq ($after|ConvertTo-Json -Depth 24 -Compress)
}
function Get-InstalledUpgradeState($Release,[string]$PreviousRoot,[switch]$RequireSelected) {
    # Retain the active canonical state. Never migrate it back through source or
    # trust a stale PID from the previous cutover after an ordinary restart.
    $previous=Read-McpCcInstalledRelease (Join-Path $PreviousRoot 'mcp_control_center')
    Assert-McpCcInstalledClosure $previous
    if($previous.schemaVersion -notin @(5,6) -or $previous.state.operatorSid -cne $operator.sid -or
        $previous.state.userProfile -ine $operator.userProfile -or $previous.state.localAppData -ine $operator.localAppData){throw 'UPGRADE_OPERATOR_OR_RELEASE_REJECTED'}
    if($Release){
        if($Release.schemaVersion -ne $previous.schemaVersion -or $previous.releaseId -ceq $Release.releaseId -or
            $previous.legacyWorkspaceRoot -ine $Release.legacyWorkspaceRoot){throw 'UPGRADE_RELEASE_REJECTED'}
        foreach($name in @('operatorSid','userProfile','localAppData','ownerRoot','dataDir','codexHome','projectsFile')){
            if($previous.state.$name -cne $Release.state.$name){throw 'UPGRADE_STATE_SCOPE_CHANGED'}
        }
        if($previous.deployment.projectsSha256 -cne $Release.deployment.projectsSha256 -or
            $previous.deployment.credentialSha256 -cne $Release.deployment.credentialSha256 -or
            $previous.cutover.tunnelProfileSha256 -cne $Release.cutover.tunnelProfileSha256){throw 'UPGRADE_CONFIGURATION_CHANGED'}
        if($previous.cutover.httpTokenSha256 -cne $Release.cutover.httpTokenSha256){
            # Only first-time v6 initialization; no rotation, removal or v5 change.
            if($previous.schemaVersion -ne 6 -or $previous.cutover.httpTokenSha256 -cne '' -or
                $Release.cutover.httpTokenSha256 -cnotmatch '^[0-9a-f]{64}$'){throw 'UPGRADE_CONFIGURATION_CHANGED'}
            # Bind the candidate to the exact privately persisted secret. An env
            # override or an arbitrary well-formed hash cannot authorize this change.
            $verified=Read-CbPersistedBearer $Release $verifier $Release.cutover.httpTokenSha256
            $verified=$null
        }
    }
    $owner=Get-McpCcInstalledStateRoot $previous
    foreach($path in @($owner,$previous.state.dataDir)){
        & $verifier {param($p,$s) Assert-McpCcInstalledPrivateTree $p $s} $path $operator.sid
    }
    $runtime=Join-Path $owner ('installed-bridge\'+$previous.releaseId)
    & $verifier {param($p,$s) Assert-McpCcInstalledStateReceipt $p $s} $runtime $operator.sid
    $receiptPath=Join-Path $runtime 'state-binding.json';$backup=Join-Path $runtime 'state-acl-before.json'
    $receipt=Read-BoundedJson $receiptPath 4096;$plan=Read-BoundedJson $backup 16777216
    $manifestHash=(Get-FileHash -LiteralPath $previous.sourcePath).Hash.ToLowerInvariant()
    if((Get-StatePlanHash $plan) -cne $receipt.planSha256 -or $plan.releaseId -cne $previous.releaseId -or
        -not(Test-InstalledStateManifest $previous $plan.manifestSha256)){throw 'UPGRADE_STATE_PLAN_CHANGED'}
    $cutover=Join-Path $runtime 'operator-cutover.json';$accepted=Read-BoundedJson $cutover 4096
    if($accepted.contract -cne 'mcpcc-installed-cutover-v1' -or $accepted.phase -cne 'LOCAL_ACCEPTED' -or
        $accepted.releaseId -cne $previous.releaseId -or $accepted.operatorSid -cne $operator.sid){throw 'UPGRADE_PREVIOUS_NOT_ACCEPTED'}
    if($RequireSelected){
        $startupHash=Assert-InstalledUpgradeSelection $previous
        if($Release -and $startupHash -cne $Release.cutover.legacyStartupSha256){throw 'UPGRADE_STARTUP_CHANGED'}
    }
    return [pscustomobject][ordered]@{contract='installed-active-state-reuse-v1';releaseRoot=$previous.root;releaseId=$previous.releaseId;
        manifestSha256=$manifestHash;receiptSha256=(Get-FileHash -LiteralPath $receiptPath).Hash.ToLowerInvariant();
        backupSha256=(Get-FileHash -LiteralPath $backup).Hash.ToLowerInvariant();cutoverSha256=(Get-FileHash -LiteralPath $cutover).Hash.ToLowerInvariant()}
}
function Get-CutoverBaselineRoot($Release,[string]$RuntimeRoot) {
    & $verifier {param($p,$s) Assert-McpCcInstalledStateReceipt $p $s} $RuntimeRoot $operator.sid
    $saved=Read-BoundedJson (Join-Path $RuntimeRoot 'state-acl-before.json') 16777216
    $receipt=Read-BoundedJson (Join-Path $RuntimeRoot 'state-binding.json') 4096
    if((Get-StatePlanHash $saved) -cne $receipt.planSha256 -or $saved.releaseId -cne $Release.releaseId -or
        -not(Test-InstalledStateManifest $Release $saved.manifestSha256)){throw 'CUTOVER_STATE_PLAN_CHANGED'}
    if($saved.PSObject.Properties['ownerReuse'] -and $saved.ownerReuse -and $saved.ownerReuse.contract -ceq 'installed-active-state-reuse-v1'){
        $current=Get-InstalledUpgradeState $Release $saved.ownerReuse.releaseRoot
        if((Get-StatePlanHash $current) -cne (Get-StatePlanHash $saved.ownerReuse)){throw 'UPGRADE_BASELINE_CHANGED'}
        return $current.releaseRoot
    }
    if($Release.schemaVersion -eq 6){throw 'MIGRATION_USE_MIGRATION_ACTIONS'}
    return $Release.legacyWorkspaceRoot
}
function Get-StateBindingPlan($Release,[string]$PreviousRoot='',[string]$RecoveryPath='',[string]$RecoveryHash='',[switch]$AllowSourceAdvance,[string]$UpgradeRoot='') {
    if($Release.schemaVersion -notin @(4,5,6)){throw 'STATE_BINDING_V4_REQUIRED'}
    $owner=Get-McpCcInstalledStateRoot $Release
    if($Release.schemaVersion -eq 6 -and -not $UpgradeRoot){throw 'MIGRATION_OR_V6_UPGRADE_REQUIRED'}
    if($UpgradeRoot -and ($Release.schemaVersion -notin @(5,6) -or $PreviousRoot -or $RecoveryPath -or $RecoveryHash -or
        $AllowSourceAdvance -or -not(Test-Path -LiteralPath $owner))){throw 'UPGRADE_STATE_INPUT_REJECTED'}
    # The manifest parser fixes this MVP's scope. Never recurse into the workspace,
    # shared .codex, another component's credential directory or a volume root.
    $expectedData=if($Release.schemaVersion -eq 6){Join-Path $Release.legacyWorkspaceRoot 'codex_bridge\.local\runtime'}else{'C:\CodexBridge'}
    if($Release.state.dataDir -ine $expectedData -or $Release.state.operatorSid -cne $operator.sid -or $Release.state.userProfile -ine $operator.userProfile -or
        $Release.state.localAppData -ine $operator.localAppData){throw 'STATE_SCOPE_REJECTED'}
    $migration=$null;$reuse=$null
    if($Release.schemaVersion -in @(5,6)){
        if(Test-Path -LiteralPath $owner){
            if($UpgradeRoot){$reuse=Get-InstalledUpgradeState $Release $UpgradeRoot -RequireSelected}
            elseif($PreviousRoot){$reuse=Get-InactiveBoundState $Release $PreviousRoot $RecoveryPath $RecoveryHash -AllowSourceAdvance:$AllowSourceAdvance}
            else{throw 'OWNER_DESTINATION_EXISTS_INSPECT_DO_NOT_RETRY'}
        }elseif($PreviousRoot){throw 'STATE_REUSE_OWNER_MISSING'}
        & $verifier {param($p,$s) Assert-McpCcInstalledPrivatePath $p $s -IntegrityOnly} (Split-Path -Parent $owner) $operator.sid
        if(-not $UpgradeRoot){$migration=Get-OwnerMigrationPlan $Release}
        if($reuse -and $reuse.PSObject.Properties['sourceAdvance'] -and
            (Get-StatePlanHash $migration) -cne $reuse.sourceAdvance.migrationSha256){throw 'SOURCE_ADVANCE_CHANGED_DURING_PLAN'}
    }else{
        if($PreviousRoot){throw 'STATE_REUSE_V5_REQUIRED'}
        & $verifier {param($p,$s) Assert-McpCcInstalledPrivatePath $p $s -IntegrityOnly} $owner $operator.sid
    }
    & $verifier {param($p,$s) Assert-McpCcInstalledPrivatePath $p $s -IntegrityOnly} (Split-Path -Parent $Release.state.dataDir) $operator.sid
    & $verifier {param($p,$s) Assert-McpCcInstalledPrivatePath $p $s -IntegrityOnly} $Release.state.codexHome $operator.sid
    $roots=@($owner,$Release.state.dataDir)
    $rows=New-Object 'Collections.Generic.List[object]'
    $queue=New-Object 'Collections.Generic.Stack[string]'
    foreach($root in $roots){if($reuse -or ($migration -and $root -ieq $owner)){continue};$queue.Push($root)}
    while($queue.Count){
        $path=$queue.Pop()
        if($rows.Count -ge 10000){throw 'STATE_TREE_LIMIT'}
        & $verifier {param($p) Assert-McpCcNoReparseChain $p} $path
        $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
        $acl=Get-Acl -LiteralPath $path -ErrorAction Stop
        $next=& $verifier {param($a,$s,$d) Get-McpCcInstalledPrivateAcl $a $s $d} $acl $operator.sid $item.PSIsContainer
        $sections=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
        $rows.Add([pscustomobject][ordered]@{path=$path;directory=[bool]$item.PSIsContainer;before=$acl.GetSecurityDescriptorSddlForm($sections);after=$next.GetSecurityDescriptorSddlForm($sections)})
        if($item.PSIsContainer){foreach($child in Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop){$queue.Push($child.FullName)}}
    }
    $runtime=Join-Path $owner ('installed-bridge\'+$Release.releaseId)
    $files=@(& $verifier {param($r,$p) Get-McpCcInstalledDeploymentFiles $r $p} $Release $runtime)
    if($UpgradeRoot){
        $previousRuntime=Join-Path $owner ('installed-bridge\'+$reuse.releaseId)
        $previousFiles=@(& $verifier {param($r,$p) Get-McpCcInstalledDeploymentFiles $r $p} $Release $previousRuntime)
        for($i=0;$i -lt $files.Count;$i++){$files[$i].source=$previousFiles[$i].target}
    }
    foreach($file in $files){
        & $verifier {param($p) Assert-McpCcNoReparseChain $p} $file.source
        if((Get-Item -LiteralPath $file.source).Length -gt $file.limit -or (Get-FileHash -LiteralPath $file.source).Hash.ToLowerInvariant() -cne $file.sha256){throw 'DEPLOYMENT_SOURCE_CHANGED'}
    }
    # Ordinal ordering makes the review digest independent of provider enumeration.
    $paths=[string[]]@($rows | ForEach-Object {$_.path});[Array]::Sort($paths,[StringComparer]::Ordinal)
    $byPath=@{};foreach($row in $rows){$byPath[$row.path]=$row}
    return [pscustomobject][ordered]@{contract='installed-state-plan-v1';releaseId=$Release.releaseId;
        manifestSha256=(Get-FileHash -LiteralPath $Release.sourcePath).Hash.ToLowerInvariant();
        roots=$roots;entries=@($paths|ForEach-Object{$byPath[$_]});files=$files;migration=$migration;ownerReuse=$reuse}
}
function Get-StatePlanHash($Plan) {
    $hash=[Security.Cryptography.SHA256]::Create()
    try{return ([BitConverter]::ToString($hash.ComputeHash($utf8.GetBytes(($Plan|ConvertTo-Json -Depth 8 -Compress))))).Replace('-','').ToLowerInvariant()}
    finally{$hash.Dispose()}
}
function New-StateDirectory([string]$Path,[string]$OwnerRoot) {
    if(-not $Path.StartsWith($OwnerRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'STATE_DIRECTORY_SCOPE_REJECTED'}
    if(Test-Path -LiteralPath $Path){
        & $verifier {param($p,$s) Assert-McpCcInstalledPrivatePath $p $s -IntegrityOnly} $Path $operator.sid
        return
    }
    $parent=Split-Path -Parent $Path
    if($parent -ine $OwnerRoot){New-StateDirectory $parent $OwnerRoot}
    & $verifier {param($p,$s) Assert-McpCcInstalledPrivatePath $p $s -IntegrityOnly} $parent $operator.sid
    # Empty directory first: preserve inherited Deny before any bytes are written.
    New-Item -ItemType Directory -Path $Path -ErrorAction Stop | Out-Null
    $acl=& $verifier {param($p,$s) Get-McpCcInstalledPrivateAcl (Get-Acl -LiteralPath $p) $s $true} $Path $operator.sid
    Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
    if(-not(& $verifier {param($a,$b) Test-McpCcInstalledAclWrite $a $b} (Get-Acl -LiteralPath $Path) $acl)){throw 'STATE_DIRECTORY_ACL_UNVERIFIED'}
    & $verifier {param($p,$s) Assert-McpCcInstalledPrivatePath $p $s} $Path $operator.sid
}
function Copy-StateSnapshot($File) {
    # No secret decoding, ambient-key fallback, source mutation, or raw output.
    & $verifier {param($p) Assert-McpCcNoReparseChain $p} $File.source
    & $verifier {param($p,$s) Assert-McpCcInstalledPrivatePath $p $s} (Split-Path -Parent $File.target) $operator.sid
    $sourceStream=[IO.File]::Open($File.source,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $hash=[Security.Cryptography.SHA256]::Create()
    try {
        if($sourceStream.Length -gt $File.limit){throw 'DEPLOYMENT_SOURCE_LIMIT'}
        $digest=([BitConverter]::ToString($hash.ComputeHash($sourceStream))).Replace('-','').ToLowerInvariant()
        if($digest -cne $File.sha256){throw 'DEPLOYMENT_SOURCE_CHANGED'}
        $sourceStream.Position=0
        $output=[IO.File]::Open($File.target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try{$sourceStream.CopyTo($output);$output.Flush($true)}finally{$output.Dispose()}
    } finally{$hash.Dispose();$sourceStream.Dispose()}
    if((Get-FileHash -LiteralPath $File.target).Hash.ToLowerInvariant() -cne $File.sha256){throw 'DEPLOYMENT_COPY_MISMATCH'}
}
function Invoke-StateBinding($Release,[string]$ExpectedHash,[string]$PreviousRoot='',[string]$RecoveryPath='',[string]$RecoveryHash='',[switch]$AllowSourceAdvance,[string]$UpgradeRoot='') {
    $owner=Get-McpCcInstalledStateRoot $Release
    $runtime=Join-Path $owner ('installed-bridge\'+$Release.releaseId)
    if(Test-Path -LiteralPath $runtime){throw 'STATE_BINDING_EXISTS_INSPECT_DO_NOT_RETRY'}
    $plan=Get-StateBindingPlan $Release $PreviousRoot $RecoveryPath $RecoveryHash -AllowSourceAdvance:$AllowSourceAdvance -UpgradeRoot $UpgradeRoot
    if($ExpectedHash -cnotmatch '^[0-9a-f]{64}$' -or (Get-StatePlanHash $plan) -cne $ExpectedHash){throw 'STATE_PLAN_CHANGED_NO_MUTATION'}
    $reuse=if($plan.PSObject.Properties['ownerReuse']){$plan.ownerReuse}else{$null}
    if($plan.migration -and -not $reuse){
        # First mutation is a new empty root; source state is never moved/deleted.
        # A failure here leaves an existing destination and prohibits a retry.
        $rootRow=@($plan.migration.entries|Where-Object{$_.relative -ceq ''})
        if($rootRow.Count -ne 1){throw 'OWNER_MIGRATION_ROOT_INVALID'}
        Copy-OwnerMigrationEntry $rootRow[0] $plan.migration.source $owner
    }
    New-StateDirectory $runtime $owner
    $receipt=Join-Path $runtime 'state-binding.json'
    $backup=Join-Path $runtime 'state-acl-before.json'
    # ACL metadata only, written before the first existing ACL is changed.
    [IO.File]::WriteAllText($backup,($plan|ConvertTo-Json -Depth 8),$utf8)
    Write-Receipt $receipt @{contract='installed-state-binding-v1';phase='APPLYING';planSha256=$ExpectedHash;backup=$backup}
    try {
        if($reuse -and $reuse.PSObject.Properties['sourceAdvance']){
            $ownerBackup=Join-Path $runtime 'legacy-owner-backup'
            foreach($row in $plan.migration.entries){Copy-OwnerMigrationEntry $row $plan.migration.source $ownerBackup}
            Assert-RemoteReceiptsTerminal $ownerBackup
            Assert-OwnerMigrationSourceUnchanged $Release $runtime
            foreach($row in $reuse.sourceAdvance.receiptImports){
                $target=Join-Path $owner $row.relative
                if(-not(Test-Path -LiteralPath $target)){
                    New-StateDirectory (Split-Path -Parent $target) $owner
                    Copy-OwnerMigrationEntry $row $plan.migration.source $owner
                }elseif((Get-FileHash -LiteralPath $target).Hash.ToLowerInvariant() -cne $row.sha256){throw 'SOURCE_ADVANCE_RECEIPT_CONFLICT'}
            }
        }
        if($plan.migration -and -not $reuse){
            $ownerBackup=Join-Path $runtime 'legacy-owner-backup'
            foreach($row in $plan.migration.entries){Copy-OwnerMigrationEntry $row $plan.migration.source $ownerBackup}
            Assert-RemoteReceiptsTerminal $ownerBackup
            Assert-OwnerMigrationSourceUnchanged $Release $runtime
            foreach($row in $plan.migration.entries){
                # The retained backup includes old PIDs; the active root must
                # publish only the new exact owner PID after Cutover.
                if($row.relative -in @('','tray.pid')){continue}
                Copy-OwnerMigrationEntry $row $plan.migration.source $owner
            }
        }
        # Children first: protecting a parent must not silently change a later
        # child's reviewed inherited rules. Preserve every Deny as an explicit rule.
        foreach($row in @($plan.entries|Sort-Object { $_.path.Length } -Descending)){
            & $verifier {param($p) Assert-McpCcNoReparseChain $p} $row.path
            $acl=Get-Acl -LiteralPath $row.path -ErrorAction Stop
            $sections=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
            if($acl.GetSecurityDescriptorSddlForm($sections) -cne $row.before){throw 'STATE_ACL_CHANGED_STOP'}
            # Only the DACL changes. Existing owner/group are reviewed and retained;
            # do not ask a normal token to reassign a SYSTEM-owned object's owner.
            $acl.SetSecurityDescriptorSddlForm($row.after,[Security.AccessControl.AccessControlSections]::Access)
            Set-Acl -LiteralPath $row.path -AclObject $acl -ErrorAction Stop
            if(-not(& $verifier {param($a,$b) Test-McpCcInstalledAclWrite $a $b} (Get-Acl -LiteralPath $row.path) $acl)){throw 'STATE_ACL_WRITE_UNVERIFIED'}
        }
        foreach($file in $plan.files){New-StateDirectory (Split-Path -Parent $file.target) $owner;Copy-StateSnapshot $file}
        # Re-inventory all private entries after the mutation, including new files.
        foreach($root in $plan.roots){& $verifier {param($p,$s) Assert-McpCcInstalledPrivateTree $p $s} $root $operator.sid}
        Assert-OwnerMigrationSourceUnchanged $Release $runtime
        if($reuse){
            $currentReuse=if($UpgradeRoot){Get-InstalledUpgradeState $Release $UpgradeRoot -RequireSelected}else{Get-InactiveBoundState $Release $PreviousRoot $RecoveryPath $RecoveryHash -AllowSourceAdvance:$AllowSourceAdvance}
            if((Get-StatePlanHash $currentReuse) -cne (Get-StatePlanHash $reuse)){throw 'STATE_REUSE_EVIDENCE_CHANGED'}
        }
        Write-Receipt $receipt @{contract='installed-state-binding-v1';phase='STATE_BOUND';planSha256=$ExpectedHash;backup=$backup}
        $null=Get-McpCcInstalledBridgeBinding (Join-Path $Release.root 'codex_bridge')
        [pscustomobject]@{phase='STATE_BOUND';releaseId=$Release.releaseId;ownerRoot=$owner;ownerMigrationPrepared=($null -ne $plan.migration -and -not $reuse);ownerStateReused=($null -ne $reuse);aclEntries=$plan.entries.Count;snapshots=$plan.files.Count;canonicalDataMoved=$false;startupChanged=$false;receipt=$receipt}|ConvertTo-Json
    } catch {
        Write-Receipt $receipt @{contract='installed-state-binding-v1';phase='UNKNOWN';planSha256=$ExpectedHash;backup=$backup}
        throw
    }
}

Assert-IndependentOperator
if($InitializeBridgeBearer -and ($Action -ne 'Prepare' -or -not $UpgradeFromReleaseRoot -or $RuntimeMigration)){
    throw 'BRIDGE_BEARER_INITIALIZATION_ACTION_REJECTED'
}
if($RecoverR15PreCopy -and $Action -notin @('MigrationPlan','MigrationApply')){throw 'MIGRATION_INCIDENT_ACTION_REJECTED'}
if($RuntimeMigration -and ($Action -ne 'Prepare' -or -not $UpgradeFromReleaseRoot)){throw 'MIGRATION_PREPARE_REQUIRES_PREVIOUS_RELEASE'}
if($Action -like 'Migration*'){
    if($operator.isAdmin){throw 'MIGRATION_REQUIRES_ORIGINAL_NON_ADMIN_OPERATOR'}
    . (Join-Path $PSScriptRoot 'installed-runtime-migration.ps1')
    Invoke-InstalledRuntimeMigration -Verb $Action -TargetReleaseRoot $ReleaseRoot -PreviousRoot $PreviousReleaseRoot -ExpectedPlanHash $StatePlanSha256 -RecoverR15PreCopy:$RecoverR15PreCopy
    exit 0
}
if($UpgradeFromReleaseRoot -and ($Action -notin @('Prepare','PlanState','BindState') -or
    $PreviousReleaseRoot -or $StateRecoveryReceipt -or $StateRecoverySha256 -or $AllowRecoveredSourceAdvance)){throw 'UPGRADE_ACTION_REJECTED'}
if($AllowRecoveredSourceAdvance -and ($Action -notin @('PlanState','BindState') -or
    -not $PreviousReleaseRoot -or -not $StateRecoveryReceipt -or -not $StateRecoverySha256)){throw 'SOURCE_ADVANCE_ACTION_REJECTED'}
if($PreviousReleaseRoot -and $Action -notin @('PlanState','BindState')){throw 'STATE_REUSE_ACTION_REJECTED'}
if(($StateRecoveryReceipt -or $StateRecoverySha256) -and
    ($Action -notin @('PlanState','BindState') -or -not $PreviousReleaseRoot -or -not $StateRecoveryReceipt -or -not $StateRecoverySha256)){throw 'STATE_RECOVERY_ACTION_REJECTED'}
if(($Action -eq 'Install') -ne $operator.isAdmin){throw 'INSTALL_REQUIRES_ADMIN_OTHER_ACTIONS_REQUIRE_ORIGINAL_NON_ADMIN_OPERATOR'}
if($Action -eq 'Prepare') {
    if($ReleaseId -cnotmatch '^[a-z0-9][a-z0-9._-]{0,63}$' -or -not $CandidateRoot -or -not $PackageRoot -or (Test-Path -LiteralPath $PackageRoot)){throw 'NEW_PACKAGE_AND_RELEASE_ID_REQUIRED'}
    $CandidateRoot=[IO.Path]::GetFullPath($CandidateRoot).TrimEnd('\');$PackageRoot=[IO.Path]::GetFullPath($PackageRoot).TrimEnd('\')
    $LegacyWorkspaceRoot=[IO.Path]::GetFullPath($LegacyWorkspaceRoot)
    if($CandidateRoot -ieq $LegacyWorkspaceRoot -or $CandidateRoot.StartsWith($LegacyWorkspaceRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'ISOLATED_BUILT_CANDIDATE_REQUIRED'}
    $previous=$null;$baselineRoot=$LegacyWorkspaceRoot
    if($UpgradeFromReleaseRoot){
        $upgrade=Get-InstalledUpgradeState $null $UpgradeFromReleaseRoot -RequireSelected
        $previous=Read-McpCcInstalledRelease (Join-Path $upgrade.releaseRoot 'mcp_control_center')
        if($RuntimeMigration -and $previous.schemaVersion -ne 5){throw 'MIGRATION_V5_BASE_REQUIRED'}
        if($previous.legacyWorkspaceRoot -ine $LegacyWorkspaceRoot){throw 'UPGRADE_WORKSPACE_CHANGED'}
        $baselineRoot=$previous.root
    }
    $h=Get-Health;Assert-OwnedReady (Invoke-Controller (Join-Path $baselineRoot 'codex_bridge') Status) $h
    Assert-HttpAuthentication -Release $previous
    if($InitializeBridgeBearer){Initialize-CbInstalledBearer $previous $verifier}
    elseif($previous -and $previous.schemaVersion -eq 6 -and $previous.cutover.httpTokenSha256 -cne ''){
        Set-CbInstalledBearerEnvironment $previous $verifier
    }
    $startup=Join-Path ([Environment]::GetFolderPath('Startup')) 'MCP Control Center.lnk'
    if(-not $previous){
        $shell=New-Object -ComObject WScript.Shell
        try {
            $lnk=$shell.CreateShortcut($startup)
            if($lnk.TargetPath -ine 'C:\Windows\System32\wscript.exe' -or $lnk.Arguments -cne ('"'+(Join-Path $LegacyWorkspaceRoot 'mcp_control_center\scripts\start-tray.vbs')+'"')){throw 'LEGACY_STARTUP_UNVERIFIED'}
        } finally {[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)}
    }
    $startupHash=(Get-FileHash -LiteralPath $startup).Hash.ToLowerInvariant()
    if(-not $ProjectsFile){$ProjectsFile=Join-Path $LegacyWorkspaceRoot 'codex_bridge\.local\projects.json'}
    if(-not $CodexHome){$CodexHome=Join-Path $operator.userProfile '.codex'}
    $settings=Join-Path $LegacyWorkspaceRoot 'codex_bridge\.local\tray-settings.json'
    if(-not $previous -and (Test-Path -LiteralPath $settings)){
        $cfg=Read-BoundedJson $settings
        foreach($pair in @(@('dataDir',$DataDir),@('projectsFile',$ProjectsFile))){
            $v=$cfg.PSObject.Properties[$pair[0]]
            if($v -and $v.Value -and [IO.Path]::GetFullPath([string]$v.Value) -ine [IO.Path]::GetFullPath($pair[1])){throw 'EXPLICIT_STATE_MUST_MATCH_LEGACY_SETTINGS'}
        }
    }
    New-Item -ItemType Directory -Path $PackageRoot | Out-Null
    $cc=Join-Path $PackageRoot 'mcp_control_center';$bridge=Join-Path $PackageRoot 'codex_bridge'
    New-Item -ItemType Directory -Path $cc,$bridge | Out-Null
    foreach($dir in @('src','config')){Copy-CodeTree (Join-Path $CandidateRoot "mcp_control_center\$dir") (Join-Path $cc $dir)}
    foreach($dir in @('src','dist','web','control-center','node_modules')){Copy-CodeTree (Join-Path $CandidateRoot "codex_bridge\$dir") (Join-Path $bridge $dir)}
    # Ship only the selected lifecycle surface. Legacy standalone tunnel/Startup/
    # restart launchers must not reintroduce mutable selectors into installed code.
    $scriptLists=@{
        mcp_control_center=@('tray.ps1','control-center.ps1','component-health.ps1','invoke-component-controller.ps1');
        codex_bridge=@('runtime-control.ps1','codex-bridge-runtime.psm1','bridge-bearer.ps1','component-runtime.psm1','runtime-build-id.mjs','OwnedProcess.Native.cs','self-reload-pipe-client.ps1','powershell-host-transport.ps1','process-identity.ps1','cooperative-shutdown-host.ps1','control-center-ui.ps1','installed-release-operator.ps1','installed-runtime-migration.ps1','check-migration-approvals.mjs')
    }
    foreach($componentName in $scriptLists.Keys){
        $destination=Join-Path $PackageRoot ($componentName+'\scripts');New-Item -ItemType Directory $destination|Out-Null
        foreach($name in $scriptLists[$componentName]){
            $from=Join-Path $CandidateRoot ($componentName+'\scripts\'+$name)
            & $verifier {param($p) Assert-McpCcNoReparseChain $p} $from
            Copy-Item -LiteralPath $from -Destination (Join-Path $destination $name)
        }
    }
    $descriptorPath=Join-Path $bridge 'control-center\component.json'
    $descriptor=Read-BoundedJson $descriptorPath
    $descriptor.capabilities=@($descriptor.capabilities|Where-Object{$_ -cne 'show_diagnostic_tray'})
    $descriptor.traits=@($descriptor.traits|Where-Object{$_ -cne 'diagnostic-ui'})
    $descriptor.lifecycle.PSObject.Properties.Remove('diagnosticLauncher')
    $descriptor.PSObject.Properties.Remove('legacyStartup')
    [IO.File]::WriteAllText($descriptorPath,($descriptor|ConvertTo-Json -Depth 12),$utf8)
    # Compile while unprivileged, then bind the DLL bytes into the release tree.
    # Runtime never compiles/loads native helpers through writable TEMP.
    $framework='C:\Windows\Microsoft.NET\Framework64\v4.0.30319'
    $nativeBuilds=@(
        @{output=(Join-Path $cc 'src\RemoteSelfReload.Native.dll');sources=@((Join-Path $cc 'src\RemoteSelfReload.Native.cs'));references=@()},
        @{output=(Join-Path $cc 'src\InstalledRelease.Native.dll');sources=@((Join-Path $cc 'src\InstalledRelease.Native.cs'));references=@()},
        @{output=(Join-Path $bridge 'scripts\OwnedProcess.Native.dll');sources=@((Join-Path $bridge 'scripts\OwnedProcess.Native.cs'));references=@()},
        @{output=(Join-Path $cc 'src\NormalOperator.Host.dll');sources=@(
            'NormalOperator.Native.cs','NormalOperator.Pipe.cs','NormalOperator.Security.cs','NormalOperator.Execution.cs','NormalOperator.Host.cs'
        ) | ForEach-Object {Join-Path $cc ('src\'+$_)};references=@('System.Web.Extensions.dll','System.Windows.Forms.dll','System.Drawing.dll')}
    )
    foreach($native in $nativeBuilds){
        if(Test-Path -LiteralPath $native.output){throw 'PREBUILT_NATIVE_OUTPUT_REJECTED'}
        foreach($source in $native.sources){
            & $verifier {param($p) Assert-McpCcNoReparseChain $p} $source
            if(-not(Test-Path -LiteralPath $source -PathType Leaf)){throw 'NATIVE_SOURCE_REQUIRED'}
        }
        $references=@('mscorlib.dll','System.dll','System.Core.dll','System.Security.dll')+$native.references |
            ForEach-Object {'/r:'+(Join-Path $framework $_)}
        & (Join-Path $framework 'csc.exe') /nologo /noconfig /nostdlib+ /target:library ('/out:'+$native.output) $references $native.sources | Out-Null
        if($LASTEXITCODE -ne 0){throw 'NATIVE_COMPILE_FAILED'}
    }
    foreach($file in @('package.json','package-lock.json')){Copy-Item -LiteralPath (Join-Path $CandidateRoot "codex_bridge\$file") -Destination (Join-Path $bridge $file)}
    $deps=Join-Path $PackageRoot 'dependencies';New-Item -ItemType Directory $deps | Out-Null
    if($previous){$NodeDistribution=Split-Path -Parent $previous.dependencies.node.path}
    Copy-CodeTree $NodeDistribution (Join-Path $deps 'node')
    foreach($dir in @('tunnel-client','key-store')){New-Item -ItemType Directory (Join-Path $deps $dir)|Out-Null}
    $tunnelSource=if($previous){$previous.dependencies.tunnelClient.path}else{Join-Path $LegacyWorkspaceRoot 'project_reading\vendor\tunnel-client\tunnel-client.exe'}
    $keyStoreSource=if($previous){$previous.dependencies.keyStore.path}else{Join-Path $LegacyWorkspaceRoot 'project_reading\scripts\key-store.ps1'}
    Copy-Item -LiteralPath $tunnelSource -Destination (Join-Path $deps 'tunnel-client\tunnel-client.exe')
    Copy-Item -LiteralPath $keyStoreSource -Destination (Join-Path $deps 'key-store\key-store.ps1')
    $registry=Read-BoundedJson (Join-Path $cc 'config\registry.json')
    if($registry.schemaVersion -ne 3 -or @($registry.components).Count -ne 8){throw 'LEGACY_EIGHT_COMPONENT_REGISTRY_REQUIRED'}
    $registry.schemaVersion=4;foreach($c in $registry.components){$c.root=$c.id}
    [IO.File]::WriteAllText((Join-Path $cc 'config\registry.json'),($registry|ConvertTo-Json -Depth 10),$utf8)
    $paths=[ordered]@{node='dependencies\node\node.exe';tunnelClient='dependencies\tunnel-client\tunnel-client.exe';keyStore='dependencies\key-store\key-store.ps1';codexLauncher='codex_bridge\node_modules\@openai\codex\bin\codex.js';codexNative='codex_bridge\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'}
    $paths.releaseVerifier='mcp_control_center\src\InstalledRelease.Native.dll'
    $hashes=[ordered]@{};foreach($key in $paths.Keys){$hashes[$key]=(Get-FileHash -LiteralPath (Join-Path $PackageRoot $paths[$key])).Hash.ToLowerInvariant()}
    $trees=[ordered]@{};foreach($name in @('mcp_control_center','codex_bridge','dependencies')){$trees[$name]=& $verifier {param($p) Get-McpCcInstalledTreeHash $p} (Join-Path $PackageRoot $name)}
    $manifest=[ordered]@{contract='mcpcc-installed-release-v5';schemaVersion=5;releaseId=$ReleaseId;legacyWorkspaceRoot=$LegacyWorkspaceRoot;dependencies=$hashes;treeHashes=$trees;
        state=@{operatorSid=$operator.sid;userProfile=$operator.userProfile;localAppData=$operator.localAppData;ownerRoot='C:\McpControlCenter';dataDir=[IO.Path]::GetFullPath($DataDir);projectsFile=[IO.Path]::GetFullPath($ProjectsFile);codexHome=[IO.Path]::GetFullPath($CodexHome)};
        cutover=@{httpTokenSha256=(& $verifier {Get-McpCcInstalledTokenHash $env:CODEX_BRIDGE_HTTP_TOKEN});tunnelProfileSha256=$(if($previous){$previous.cutover.tunnelProfileSha256}else{(Get-FileHash -LiteralPath (Join-Path $LegacyWorkspaceRoot 'codex_bridge\.tunnel-client\codex-bridge.yaml')).Hash.ToLowerInvariant()});rollbackBuildId=$h.buildId;legacyStartupSha256=$startupHash};
        deployment=@{contract='bridge-private-snapshot-v1';projectsSha256=$(if($previous){$previous.deployment.projectsSha256}else{(Get-FileHash -LiteralPath $ProjectsFile).Hash.ToLowerInvariant()});credentialSha256=$(if($previous){$previous.deployment.credentialSha256}else{(Get-FileHash -LiteralPath (Join-Path $LegacyWorkspaceRoot 'project_reading\.secrets\control-plane-api-key.dpapi')).Hash.ToLowerInvariant()})}}
    if($previous -and $previous.schemaVersion -eq 6){
        $manifest.contract='mcpcc-installed-release-v6';$manifest.schemaVersion=6
        $manifest.state.ownerRoot=$previous.state.ownerRoot;$manifest.state.dataDir=$previous.state.dataDir
    }
    if($previous){$null=Get-InstalledUpgradeState ([pscustomobject]$manifest) $previous.root -RequireSelected}
    if($RuntimeMigration){
        # v5 stays immutable. Only this explicit migration produces the fixed v6 layout.
        $manifest.contract='mcpcc-installed-release-v6';$manifest.schemaVersion=6
        $manifest.state.ownerRoot=Join-Path $LegacyWorkspaceRoot 'mcp_control_center\.local\runtime'
        $manifest.state.dataDir=Join-Path $LegacyWorkspaceRoot 'codex_bridge\.local\runtime'
    }
    [IO.File]::WriteAllText((Join-Path $cc 'config\installed-release.json'),($manifest|ConvertTo-Json -Depth 8),$utf8)
    # Administrator consumes one locked archive, never recursively traverses a
    # writable source tree with Administrator read authority.
    $archive=$PackageRoot+'.zip'
    if(Test-Path -LiteralPath $archive){throw 'NEW_ARCHIVE_REQUIRED'}
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($PackageRoot,$archive,[IO.Compression.CompressionLevel]::Optimal,$false)
    [pscustomobject]@{phase='PACKAGED';packageFile=$archive;sha256=(Get-FileHash -LiteralPath $archive).Hash.ToLowerInvariant();releaseId=$ReleaseId;host='HOST_NOT_VERIFIED'}|ConvertTo-Json
    exit 0
}
if($Action -eq 'Install') {
    if(-not $PackageFile -or $PackageSha256 -cnotmatch '^[0-9a-f]{64}$'){throw 'PACKAGE_DIGEST_REQUIRED'}
    # Windows PowerShell 5.1 does not eagerly load FileSystem's dependency.
    # ZipArchive/ZipArchiveMode belong to System.IO.Compression itself.
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $stream=[IO.File]::Open($PackageFile,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $zip=$null;$hasher=[Security.Cryptography.SHA256]::Create()
    try {
        if($stream.Length -gt 3221225472){throw 'PACKAGE_SIZE_LIMIT'}
        $digest=([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-','').ToLowerInvariant()
        if($digest -cne $PackageSha256){throw 'PACKAGE_DIGEST_MISMATCH'}
        $stream.Position=0;$zip=New-Object IO.Compression.ZipArchive($stream,[IO.Compression.ZipArchiveMode]::Read,$true)
        # .NET Framework ZipFile writes backslashes on Windows. Use the same
        # separator normalization as extraction, rejecting ambiguous manifests.
        $manifests=@($zip.Entries | Where-Object {$_.FullName.Replace('\','/') -ceq 'mcp_control_center/config/installed-release.json'})
        if($manifests.Count -ne 1 -or $manifests[0].Length -gt 16384){throw 'PACKAGE_MANIFEST_INVALID'}
        $entry=$manifests[0]
        $reader=New-Object IO.StreamReader($entry.Open(),[Text.Encoding]::UTF8)
        try{$doc=$reader.ReadToEnd()|ConvertFrom-Json}finally{$reader.Dispose()}
        if($doc.schemaVersion -cnotin @(3,4,5,6) -or $doc.releaseId -cnotmatch '^[a-z0-9][a-z0-9._-]{0,63}$'){throw 'PACKAGE_MANIFEST_INVALID'}
        $parent='C:\Program Files\McpCcReleases';$target=Join-Path $parent $doc.releaseId
        if(Test-Path -LiteralPath $target){throw 'IMMUTABLE_RELEASE_ALREADY_EXISTS'}
        if(-not(Test-Path -LiteralPath $parent)){New-Item -ItemType Directory $parent|Out-Null;Set-NewDirectoryAcl $parent -Code -ReaderSid 'S-1-5-11'}
        Assert-McpCcProtectedCodePath $parent
        New-Item -ItemType Directory $target|Out-Null
        Set-NewDirectoryAcl $target -Code -ReaderSid $doc.state.operatorSid
        # Destination is protected before extraction. Every archive path is validated;
        # CreateNew never follows/overwrites an existing path or duplicate entry.
        $seen=@{};$bytes=0L;$count=0
        foreach($item in $zip.Entries){
            $name=$item.FullName.Replace('\','/')
            if(++$count -gt 100000 -or ($bytes+=$item.Length) -gt 3221225472 -or $seen.ContainsKey($name)){throw 'PACKAGE_ENTRY_INVALID'}
            $seen[$name]=$true
            $path=Resolve-ReleaseArchivePath $target $name $item.ExternalAttributes
            if($name.EndsWith('/')){[void][IO.Directory]::CreateDirectory($path);continue}
            [void][IO.Directory]::CreateDirectory((Split-Path -Parent $path))
            $entryStream=$item.Open();$output=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
            try{
                $buffer=New-Object byte[] 65536;$written=0L
                while(($n=$entryStream.Read($buffer,0,$buffer.Length)) -gt 0){
                    $written+=$n;if($written -gt $item.Length){throw 'PACKAGE_ENTRY_SIZE_MISMATCH'}
                    $output.Write($buffer,0,$n)
                }
                if($written -ne $item.Length){throw 'PACKAGE_ENTRY_SIZE_MISMATCH'}
            }finally{$output.Dispose();$entryStream.Dispose()}
            [IO.File]::SetLastWriteTimeUtc($path,$item.LastWriteTime.UtcDateTime)
        }
        $r=Read-McpCcInstalledRelease (Join-Path $target 'mcp_control_center');Assert-McpCcInstalledClosure $r
    } finally {if($zip){$zip.Dispose()};$hasher.Dispose();$stream.Dispose()}
    [pscustomobject]@{phase='INSTALLED_INACTIVE';releaseRoot=$target;sha256=$PackageSha256;startupChanged=$false;host='HOST_NOT_VERIFIED'}|ConvertTo-Json
    exit 0
}
if(-not $ReleaseRoot){throw 'RELEASE_ROOT_REQUIRED'}
$ReleaseRoot=[IO.Path]::GetFullPath($ReleaseRoot)
Assert-McpCcProtectedCodePath (Join-Path $ReleaseRoot 'mcp_control_center\src\McpControlCenter.InstalledRelease.psm1')
$verifier=Import-Module (Join-Path $ReleaseRoot 'mcp_control_center\src\McpControlCenter.InstalledRelease.psm1') -Force -PassThru
$release=Read-McpCcInstalledRelease (Join-Path $ReleaseRoot 'mcp_control_center')
Assert-McpCcInstalledClosure $release
if($release.schemaVersion -lt 3 -or $release.state.operatorSid -cne $operator.sid){throw 'ORIGINAL_OPERATOR_REQUIRED'}
$owner=Get-McpCcInstalledStateRoot $release
if($Action -in @('PlanState','BindState')){
    if(-not $UpgradeFromReleaseRoot){Assert-NoTray}
    $health=Get-Health -Idle
    $baselineRoot=$release.legacyWorkspaceRoot
    if($UpgradeFromReleaseRoot){$baselineRoot=(Get-InstalledUpgradeState $release $UpgradeFromReleaseRoot -RequireSelected).releaseRoot}
    Assert-OwnedReady (Invoke-Controller (Join-Path $baselineRoot 'codex_bridge') Status) $health
    if($health.buildId -cne $release.cutover.rollbackBuildId){throw 'LEGACY_BASELINE_CHANGED'}
    $lock=New-Object Threading.Mutex($false,'Local\McpCcInstalledOperator');$acquired=$false
    try{
        try{$acquired=$lock.WaitOne(0)}catch [Threading.AbandonedMutexException]{$acquired=$true}
        if(-not $acquired){throw 'CUTOVER_BUSY'}
        if($Action -eq 'PlanState'){
            $plan=Get-StateBindingPlan $release $PreviousReleaseRoot $StateRecoveryReceipt $StateRecoverySha256 -AllowSourceAdvance:$AllowRecoveredSourceAdvance -UpgradeRoot $UpgradeFromReleaseRoot
            [pscustomobject]@{phase='STATE_PLAN_READY';releaseId=$release.releaseId;statePlanSha256=(Get-StatePlanHash $plan);
                roots=$plan.roots;aclEntries=$plan.entries.Count;snapshots=$plan.files.Count;preservesAllDeny=$true;
                ownerMigration=$(if($plan.migration -and -not $plan.ownerReuse){[pscustomobject]@{source=$plan.migration.source;target=$plan.migration.target;entries=$plan.migration.entries.Count;bytes=$plan.migration.bytes;legacyRetained=$true;skipActiveTrayPid=$true}}else{$null});
                ownerStateReuse=$plan.ownerReuse;
                sharedHomeChanged=$false;workspaceAclChanged=$false;productionTouched=$false}|ConvertTo-Json -Depth 6
        }else{Invoke-StateBinding $release $StatePlanSha256 $PreviousReleaseRoot $StateRecoveryReceipt $StateRecoverySha256 -AllowSourceAdvance:$AllowRecoveredSourceAdvance -UpgradeRoot $UpgradeFromReleaseRoot}
    }finally{if($acquired){$lock.ReleaseMutex()};$lock.Dispose()}
    exit 0
}
if($release.schemaVersion -ge 4 -and -not(Test-Path -LiteralPath (Join-Path $owner ('installed-bridge\'+$release.releaseId+'\state-binding.json')))){throw 'RUN_PLANSTATE_AND_BINDSTATE_FIRST'}
& $verifier {param($p,$s) Assert-McpCcInstalledPrivatePath $p $s} $owner $operator.sid
$runtime=Join-Path $owner ('installed-bridge\'+$release.releaseId)
if(-not(Test-Path -LiteralPath $runtime)){
    if($Action -ne 'Preflight'){throw 'RUN_PREFLIGHT_FIRST'}
    $base=Split-Path -Parent $runtime
    if(-not(Test-Path -LiteralPath $base)){New-Item -ItemType Directory $base|Out-Null;Set-NewDirectoryAcl $base}
    New-Item -ItemType Directory $runtime|Out-Null;Set-NewDirectoryAcl $runtime
}
$binding=Get-McpCcInstalledBridgeBinding (Join-Path $ReleaseRoot 'codex_bridge')
$baselineRoot=if($release.schemaVersion -ge 4){Get-CutoverBaselineRoot $release $runtime}else{$release.legacyWorkspaceRoot}
$legacyBridge=Join-Path $baselineRoot 'codex_bridge'
$legacyCc=Join-Path $baselineRoot 'mcp_control_center'
$startup=Join-Path ([Environment]::GetFolderPath('Startup')) 'MCP Control Center.lnk'
$receiptPath=Join-Path $runtime 'operator-cutover.json'
$backup=Join-Path $runtime 'legacy-startup.lnk'
$isInstalledUpgrade=$baselineRoot -ine $release.legacyWorkspaceRoot
$baselineRelease=if($isInstalledUpgrade){Read-McpCcInstalledRelease $legacyCc}else{$null}
$resumeUpgrade=($Action -eq 'Cutover' -and $isInstalledUpgrade -and (Test-Path -LiteralPath $receiptPath) -and
    (Read-BoundedJson $receiptPath 4096).phase -ceq 'UPGRADE_STOPPED')
$h=if($Action -ne 'Rollback' -and -not $resumeUpgrade){Get-Health -Idle}else{$null}
if($Action -eq 'Preflight'){
    Assert-OwnerMigrationSourceUnchanged $release $runtime
    Assert-OwnedReady (Invoke-Controller $legacyBridge Status) $h
    if($h.buildId -cne $release.cutover.rollbackBuildId -or (Get-FileHash -LiteralPath $startup).Hash.ToLowerInvariant() -cne $release.cutover.legacyStartupSha256){throw 'LEGACY_BASELINE_CHANGED'}
    Assert-HttpAuthentication -Release $baselineRelease
    [pscustomobject]@{phase='PREFLIGHT_READY';releaseId=$release.releaseId;livePid=$h.pid;liveBuildId=$h.buildId;allJobsTerminal=$true;host='HOST_NOT_VERIFIED'}|ConvertTo-Json
    exit 0
}
# Operator exits the tray UI first. This deliberately does not terminate the owner or
# invent a second manager. The component remains owned until its existing controller stops it.
Assert-RemoteReceiptsTerminal $owner
$lock=New-Object Threading.Mutex($false,'Local\McpCcInstalledOperator');$acquired=$false
try {
    try {$acquired=$lock.WaitOne(0)}catch [Threading.AbandonedMutexException]{$acquired=$true}
    if(-not $acquired){throw 'CUTOVER_BUSY'}
    if($Action -eq 'Cutover'){
        if(-not $isInstalledUpgrade -or $resumeUpgrade){Assert-NoTray}
        Assert-OwnerMigrationSourceUnchanged $release $runtime
        if($resumeUpgrade){
            $receipt=Read-BoundedJson $receiptPath 4096
            if($receipt.contract -cne 'mcpcc-installed-cutover-v1' -or $receipt.releaseId -cne $release.releaseId -or
                $receipt.operatorSid -cne $operator.sid -or $receipt.oldBuildId -cne $release.cutover.rollbackBuildId -or
                $null -ne $receipt.newPid -or $null -ne $receipt.newTunnelPid -or
                (Get-FileHash -LiteralPath $backup).Hash.ToLowerInvariant() -cne $release.cutover.legacyStartupSha256){throw 'UPGRADE_STOP_RECEIPT_CHANGED'}
            foreach($identity in @(@($receipt.oldPid,$receipt.oldStartTimeUtc),@($receipt.oldTunnelPid,$receipt.oldTunnelStartTimeUtc))){
                $old=Get-Process -Id $identity[0] -ErrorAction SilentlyContinue
                if($old){try{if($old.StartTime.ToUniversalTime().ToString('o') -ceq $identity[1]){throw 'UPGRADE_PREVIOUS_STILL_RUNNING'}}finally{$old.Dispose()}}
            }
            $listeners=[Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
            if(@($listeners|Where-Object{$_.Port -in @(18828,18829)}).Count){throw 'UPGRADE_LISTENER_PRESENT'}
        }else{
            if(Test-Path -LiteralPath $receiptPath){throw 'CUTOVER_RECEIPT_EXISTS_INSPECT_DO_NOT_RETRY'}
            if($h.buildId -cne $release.cutover.rollbackBuildId -or (Get-FileHash -LiteralPath $startup).Hash.ToLowerInvariant() -cne $release.cutover.legacyStartupSha256){throw 'LEGACY_BASELINE_CHANGED'}
            $before=Invoke-Controller $legacyBridge Status
            Assert-OwnedReady $before $h;Assert-HttpAuthentication -Release $baselineRelease
            Copy-Item -LiteralPath $startup -Destination $backup
            $receipt=[ordered]@{contract='mcpcc-installed-cutover-v1';releaseId=$release.releaseId;operatorSid=$operator.sid;phase='STOPPING_LEGACY';
                oldPid=$h.pid;oldBuildId=$h.buildId;oldStartTimeUtc=(Get-Process -Id $h.pid).StartTime.ToUniversalTime().ToString('o');
                oldTunnelPid=$before.after.tunnel.pid;oldTunnelStartTimeUtc=(Get-Process -Id $before.after.tunnel.pid).StartTime.ToUniversalTime().ToString('o');
                newPid=$null;newBuildId=$null;newStartTimeUtc=$null;newTunnelPid=$null;newTunnelStartTimeUtc=$null;
                host='HOST_NOT_VERIFIED';utc=[DateTime]::UtcNow.ToString('o')}
            Write-Receipt $receiptPath $receipt
            $stopped=Invoke-Controller $legacyBridge ShutdownRuntime
            if($stopped.after.server.ownership -cne 'Stopped' -or $stopped.after.tunnel.ownership -cne 'Stopped'){throw 'LEGACY_STOP_UNKNOWN'}
            if($isInstalledUpgrade){
                # The installed controller needs its original tray owner while
                # draining. Resume only this explicit stopped phase after UI exit.
                $receipt.phase='UPGRADE_STOPPED';Write-Receipt $receiptPath $receipt
                [pscustomobject]@{phase='UPGRADE_STOPPED';next='Exit control center only, then repeat Cutover';host='HOST_NOT_VERIFIED'}|ConvertTo-Json
                exit 0
            }
        }
        $shell=New-Object -ComObject WScript.Shell
        try {$link=$shell.CreateShortcut($startup);$link.TargetPath=$ps;$link.Arguments='-NoProfile -WindowStyle Hidden -File "'+(Join-Path $ReleaseRoot 'mcp_control_center\scripts\tray.ps1')+'" -AutoReconcile';$link.WorkingDirectory=Join-Path $ReleaseRoot 'mcp_control_center';$link.Save()}finally{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)}
        $receipt.phase='SELECTED';Write-Receipt $receiptPath $receipt
        $trayPid=Start-SelectedTray (Join-Path $ReleaseRoot 'mcp_control_center')
        $deadline=[DateTime]::UtcNow.AddSeconds(30)
        do {Start-Sleep -Milliseconds 300;try{Assert-McpCcInstalledSelection $binding;break}catch{if([DateTime]::UtcNow -gt $deadline){throw 'INSTALLED_OWNER_START_UNKNOWN'}}}while($true)
        $started=Invoke-Controller (Join-Path $ReleaseRoot 'codex_bridge') EnsureRunning
        $after=Get-Health -Idle;Assert-OwnedReady $started $after;Assert-HttpAuthentication -Release $release
        $ready=Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:18829/readyz' -TimeoutSec 3 -MaximumRedirection 0
        if($ready.StatusCode -ne 200 -or $ready.Content.Trim() -notin @('ready','ok')){throw 'TUNNEL_NOT_READY'}
        $receipt.phase='LOCAL_ACCEPTED';$receipt.newPid=$after.pid;$receipt.newBuildId=$after.buildId
        $receipt.newStartTimeUtc=(Get-Process -Id $after.pid).StartTime.ToUniversalTime().ToString('o')
        $receipt.newTunnelPid=$started.after.tunnel.pid;$receipt.newTunnelStartTimeUtc=(Get-Process -Id $started.after.tunnel.pid).StartTime.ToUniversalTime().ToString('o')
        Write-Receipt $receiptPath $receipt
        $receipt|ConvertTo-Json
    } else {
        $receipt=Read-BoundedJson $receiptPath
        if($receipt.contract -cne 'mcpcc-installed-cutover-v1' -or $receipt.releaseId -cne $release.releaseId -or
            $receipt.operatorSid -cne $operator.sid -or $receipt.phase -notin @('LOCAL_ACCEPTED','ROLLBACK_STOPPED')){throw 'ROLLBACK_UNKNOWN_REQUIRES_INSPECTION'}
        if((Get-FileHash -LiteralPath $backup).Hash.ToLowerInvariant() -cne $release.cutover.legacyStartupSha256){throw 'ROLLBACK_STARTUP_CHANGED'}
        if($receipt.phase -ceq 'LOCAL_ACCEPTED'){
            $h=Get-Health -Idle
            if($h.pid -ne $receipt.newPid -or $h.buildId -cne $receipt.newBuildId -or
                (Get-Process -Id $h.pid).StartTime.ToUniversalTime().ToString('o') -cne $receipt.newStartTimeUtc){throw 'ROLLBACK_RUNTIME_CHANGED'}
            $current=Invoke-Controller (Join-Path $ReleaseRoot 'codex_bridge') Status;Assert-OwnedReady $current $h
            if($current.after.tunnel.pid -ne $receipt.newTunnelPid -or (Get-Process -Id $receipt.newTunnelPid).StartTime.ToUniversalTime().ToString('o') -cne $receipt.newTunnelStartTimeUtc){throw 'ROLLBACK_TUNNEL_CHANGED'}
            $stopped=Invoke-Controller (Join-Path $ReleaseRoot 'codex_bridge') ShutdownRuntime
            if($stopped.after.server.ownership -cne 'Stopped' -or $stopped.after.tunnel.ownership -cne 'Stopped'){throw 'ROLLBACK_STOP_UNKNOWN'}
            $receipt.phase='ROLLBACK_STOPPED';Write-Receipt $receiptPath $receipt
            [pscustomobject]@{phase='ROLLBACK_STOPPED';next='Exit control center only, then repeat this Rollback command';host='HOST_NOT_VERIFIED'}|ConvertTo-Json
        } else {
            Assert-NoTray
            $legacy=Invoke-Controller $legacyBridge Status
            if($legacy.after.canonicalBuildId -cne $receipt.oldBuildId -or $legacy.after.server.ownership -cne 'Stopped' -or $legacy.after.tunnel.ownership -cne 'Stopped'){throw 'ROLLBACK_LEGACY_CHANGED_OR_FOREIGN_LISTENER'}
            Copy-Item -LiteralPath $backup -Destination $startup -Force
            $null=Start-SelectedTray $legacyCc
            $started=Invoke-Controller $legacyBridge EnsureRunning
            $h=Get-Health -Idle;Assert-OwnedReady $started $h;Assert-HttpAuthentication -Release $baselineRelease
            if($h.buildId -cne $receipt.oldBuildId){throw 'ROLLBACK_BUILD_MISMATCH'}
            $receipt.phase='ROLLED_BACK';Write-Receipt $receiptPath $receipt
            $receipt|ConvertTo-Json
        }
    }
} catch {
    # A closed UI prerequisite has no lifecycle side effect and preserves the resumable
    # rollback phase. All other failures require explicit inspection, never a retry loop.
    if($_.Exception.Message -ne 'CLOSE_CONTROL_CENTER_UI_ONLY_THEN_REPEAT' -and (Test-Path -LiteralPath $receiptPath)){
        $r=Read-BoundedJson $receiptPath;$r|Add-Member -NotePropertyName lastPhase -NotePropertyValue $r.phase -Force;$r.phase='UNKNOWN';Write-Receipt $receiptPath $r
    }
    throw
} finally {if($acquired){$lock.ReleaseMutex()};$lock.Dispose()}
