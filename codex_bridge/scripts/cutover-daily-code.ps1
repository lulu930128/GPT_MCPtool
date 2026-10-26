<# One-time local handoff. Run from an ordinary, independent Windows PowerShell.
   -Inspect records metadata only; it never decrypts credentials or changes services.
   No elevation, scheduled task, Explorer proxy, private-state copy or force kill.
#>
[CmdletBinding()]
param([switch]$Inspect,
    [ValidatePattern('^cutover-[0-9a-f]{32}$')][string]$RecoverAfterReboot,
    [ValidatePattern('^[a-z0-9][a-z0-9_-]{0,47}$')][string]$Version='pathfix-20261025-06',
    [ValidatePattern('^[a-z0-9][a-z0-9_-]{0,47}$')][string]$ControlCenterVersion='cc-20261025-c')
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$root='C:\GPT_MCPtool\codex_bridge\Runtime'
$legacy='C:\Program Files\McpCcReleases\normal-direct-bearer-20261023'
$ps='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$release=Join-Path $root ('versions\'+$Version)
$module=Import-Module 'C:\GPT_MCPtool\mcp_control_center\src\McpControlCenter.DailyCode.psm1' -PassThru -Force
$ccSource='C:\GPT_MCPtool\mcp_control_center'
$ccDeployment=Import-Module (Join-Path $ccSource 'src\McpControlCenter.Deployment.psm1') -PassThru -Force
$phase='INSPECTING';$op=$null;$lock=$null;$oldStopped=$false;$selected=$false;$startupChanged=$false

function Write-CutoverRecord([string]$Name,$Value) {
    & $module {param($p,$v) Write-DailyNew $p $v} (Join-Path $op $Name) $Value
}
function Get-CutoverHealth {
    try {$h=Invoke-RestMethod -Uri 'http://127.0.0.1:18828/health' -TimeoutSec 5}
    catch {
        $cause=$_.Exception.GetBaseException()
        if(($_.Exception -is [Net.WebException] -and $_.Exception.Status -in @([Net.WebExceptionStatus]::ConnectFailure,[Net.WebExceptionStatus]::Timeout)) -or
            ($cause -is [Net.Sockets.SocketException] -and $cause.SocketErrorCode -in @([Net.Sockets.SocketError]::ConnectionRefused,[Net.Sockets.SocketError]::TimedOut))){throw 'CUTOVER_BRIDGE_NOT_READY'}
        throw
    }
    if($h.ok -ne $true -or $h.service -cne 'codex-handoff-bridge' -or $h.jobs.scope -cne 'all' -or
        $h.jobs.active -isnot [int] -or $h.jobs.awaitingApproval -isnot [int]){throw 'CUTOVER_JOB_STATE_UNKNOWN'}
    if($h.selfReload.contract -cne 'remote-self-reload-r1'){throw 'CUTOVER_DRAIN_STATE_UNKNOWN'}
    if($null -ne $h.selfReload.drain){throw 'ACTIVE_WORK_PRESENT'}
    return [pscustomobject]@{pid=$h.pid;buildId=$h.buildId;scope=$h.jobs.scope;active=$h.jobs.active;awaitingApproval=$h.jobs.awaitingApproval;controller=$h.controller}
}
function Assert-CutoverIdle($Health) {
    if($Health.active -ne 0 -or $Health.awaitingApproval -ne 0 -or $Health.controller -notin @('ready','idle')){throw 'ACTIVE_WORK_PRESENT'}
}
function Assert-CutoverIndependent([int]$CoreId) {
    $next=$PID;$seen=@{}
    while($next -gt 0 -and -not $seen.ContainsKey($next)) {
        if($next -eq $CoreId){throw 'CUTOVER_SELF_HOSTED_JOB'}
        $seen[$next]=$true
        $p=Get-CimInstance Win32_Process -Filter "ProcessId=$next" -ErrorAction Stop
        if($null -eq $p){break};$next=[int]$p.ParentProcessId
    }
    foreach($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()){
        if([string]$entry.Key -match '^(NODE_|OPENSSL_)' -and -not[string]::IsNullOrEmpty([string]$entry.Value)){throw 'CUTOVER_INHERITED_ENV_REJECTED'}
    }
    foreach($name in @('NODE_OPTIONS','NODE_PATH','CODEX_BRIDGE_CODEX_COMMAND','CODEX_BRIDGE_CODEX_ARGS','CODEX_BRIDGE_NODE_PATH','CODEX_BRIDGE_TUNNEL_CLIENT_PATH','CODEX_BRIDGE_KEY_STORE_PATH','CODEX_BRIDGE_EXPECTED_TEST_BUILD','CODEX_BRIDGE_TEST_ACTIVE_FLAG')) {
        if([Environment]::GetEnvironmentVariable($name,'Process')){throw 'CUTOVER_INHERITED_ENV_REJECTED'}
    }
}
function Get-CutoverOwnedRoles([string]$OwnerRoot,[string]$OperatorSid) {
    $rows=@()
    foreach($role in @('server','tunnel')) {
        $port=if($role -eq 'server'){18828}else{18829}
        $base=if($role -eq 'server'){'codex-bridge-http-server'}else{'tunnel-client'}
        $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq $port)
        $ids=@($listeners | ForEach-Object {$_.OwningProcess} | Sort-Object -Unique)
        if($ids.Count -eq 0){
            $expectedImage=Join-Path $legacy $(if($role -eq 'server'){'dependencies\node\node.exe'}else{'dependencies\tunnel-client\tunnel-client.exe'})
            $remaining=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {$_.ExecutablePath -ieq $expectedImage})
            if(-not $remaining.Count){continue}
            $ids=@($remaining.ProcessId)
        }
        if($ids.Count -ne 1 -or @($listeners|Where-Object LocalAddress -notin @('127.0.0.1','::1')).Count){throw 'CUTOVER_LISTENER_OWNER_UNKNOWN'}
        $process=Get-Process -Id $ids[0] -ErrorAction Stop
        try {
            $null=$process.Handle
            $image=Join-Path $legacy $(if($role -eq 'server'){'dependencies\node\node.exe'}else{'dependencies\tunnel-client\tunnel-client.exe'})
            $identity=if($role -eq 'server'){Join-Path $legacy 'codex_bridge\dist\src\http-main.js'}else{'codex-bridge'}
            $start=$process.StartTime.ToUniversalTime().ToString('o')
            $cim=Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)"
            $sid=Invoke-CimMethod -InputObject $cim -MethodName GetOwnerSid
            if($process.Path -ine $image -or $sid.ReturnValue -ne 0 -or $sid.Sid -cne $OperatorSid -or $cim.CommandLine.IndexOf($identity,[StringComparison]::OrdinalIgnoreCase) -lt 0){throw 'CUTOVER_PROCESS_IDENTITY_MISMATCH'}
            # Locate the actual metadata. Never manufacture ownership for a listener.
            $dirs=@((Join-Path $OwnerRoot 'installed-bridge\normal-direct-bearer-20261023'),'C:\GPT_MCPtool\codex_bridge\.tmp')
            $matches=@()
            foreach($dir in $dirs) {
                $file=Join-Path $dir ($base+'.owner.json');$pidFile=Join-Path $dir ($base+'.pid')
                if(-not(Test-Path -LiteralPath $file) -or -not(Test-Path -LiteralPath $pidFile)){continue}
                $meta=& $module {param($p) Read-DailyJson $p} $file
                if($meta.schemaVersion -eq 1 -and $meta.role -ceq $role -and $meta.pid -eq $process.Id -and
                    $meta.executablePath -ieq $image -and $meta.startTimeUtc -ceq $start -and $meta.identity -ceq $identity -and
                    [IO.File]::ReadAllText($pidFile).Trim() -ceq [string]$process.Id){$matches+= $dir}
            }
            if($matches.Count -ne 1){throw 'CUTOVER_OWNER_METADATA_MISSING_OR_AMBIGUOUS'}
            $rows+=[pscustomobject]@{role=$role;port=$port;pid=$process.Id;image=$image;startTimeUtc=$start;runtimeDir=$matches[0]}
        }finally{$process.Dispose()}
    }
    if($rows.Count -eq 2 -and $rows[0].runtimeDir -ine $rows[1].runtimeDir){throw 'CUTOVER_SPLIT_OWNER_METADATA'}
    return $rows
}
function Invoke-CutoverScript([string]$Entry,[string]$Arguments) {
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=$ps;$info.Arguments='-NoProfile -NonInteractive -File "'+$Entry+'" '+$Arguments
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $p=New-Object Diagnostics.Process;$p.StartInfo=$info
    try {
        if(-not $p.Start()){throw 'CUTOVER_CONTROLLER_START_FAILED'}
        $stdout=$p.StandardOutput.ReadToEndAsync();$stderr=$p.StandardError.ReadToEndAsync()
        if(-not $p.WaitForExit(180000)){throw 'CUTOVER_CONTROLLER_TIMEOUT_UNKNOWN'}
        $output=$stdout.GetAwaiter().GetResult();$err=$stderr.GetAwaiter().GetResult()
        if($output.Length -gt 65536 -or $err.Length -gt 65536){throw 'CUTOVER_CONTROLLER_OUTPUT_UNKNOWN'}
        $diagnostic=Get-CutoverControllerDiagnostic $output $err $p.ExitCode
        Write-CutoverRecord ('controller-'+[guid]::NewGuid().ToString('N')+'.json') $diagnostic
        if($err.Length){
            if($diagnostic.code){throw $diagnostic.code};throw 'CUTOVER_CONTROLLER_FAILED'
        }
        $result=$output|ConvertFrom-Json
        if($p.ExitCode -ne 0 -or $result.ok -ne $true){
            $code=if($result.PSObject.Properties['errorCode']){[string]$result.errorCode}else{[string]$result.code}
            if($code -cmatch '^[A-Z][A-Z_]+$'){throw $code};throw 'CUTOVER_CONTROLLER_FAILED'
        }
        return $result
    }finally{$p.Dispose()}
}
function Get-CutoverControllerDiagnostic([string]$Output,[string]$ErrorText,[int]$ExitCode) {
    # Never persist raw output/error text, environment, credential bytes or hashes.
    $known=[regex]::Match($ErrorText,'\b(?:INSTALLED|PROTECTED|DAILY|BLOCKED|ACTIVE|OWNERSHIP|COOPERATIVE|CUTOVER|IPC|CORE|CONTROLLER|ACTION)_[A-Z_]{2,80}\b')
    $code=if($known.Success){$known.Value}else{$null}
    $engineId=$null
    foreach($id in @('NoProcessFoundForGivenId','PathNotFound','ItemNotFound','CommandNotFoundException','ParameterBindingValidationException','ParameterArgumentValidationErrorEmptyStringNotAllowed','UnauthorizedAccessException','VariableIsUndefined')){
        if($ErrorText -match ('\b'+[regex]::Escape($id)+'\b')){$engineId=$id;break}
    }
    $ok=$null;$action=$null
    try {
        $result=$Output|ConvertFrom-Json -ErrorAction Stop
        if($result.PSObject.Properties['ok'] -and $result.ok -is [bool]){$ok=$result.ok}
        if($result.PSObject.Properties['action'] -and $result.action -cin @('Status','ShutdownRuntime','Preflight','Stopped','Start','Ready')){$action=$result.action}
        if(-not $code){foreach($field in @('errorCode','code')){
            if($result.PSObject.Properties[$field] -and [string]$result.$field -cmatch '^(?:INSTALLED|PROTECTED|DAILY|BLOCKED|ACTIVE|OWNERSHIP|COOPERATIVE|CUTOVER|IPC|CORE|CONTROLLER|ACTION)_[A-Z_]{2,80}$'){$code=[string]$result.$field;break}
        }}
    } catch {}
    return @{exitCode=$ExitCode;code=$code;engineErrorId=$engineId;ok=$ok;action=$action;
        stdoutCharacters=$Output.Length;stderrCharacters=$ErrorText.Length;stderrFormat=$(if($ErrorText.StartsWith('#< CLIXML')){'CLIXML'}else{'TEXT'});
        rawOutputRetained=$false;utc=[DateTime]::UtcNow.ToString('o')}
}
function Invoke-CutoverOwner([string]$Action) {
    $args='-ReleaseRoot "'+$release+'" -Action '+$Action
    $null=Invoke-CutoverScript (Join-Path $release 'codex_bridge\scripts\daily-code-owner.ps1') $args
}
function Stop-CutoverLegacy([AllowEmptyCollection()][object[]]$Roles,[string]$OwnerRoot,[string]$OperatorSid) {
    $fresh=@(Get-CutoverOwnedRoles $OwnerRoot $OperatorSid)
    if(($fresh|ConvertTo-Json -Compress) -cne ($Roles|ConvertTo-Json -Compress)){throw 'CUTOVER_OWNER_CHANGED'}
    if($fresh.Count){
        Write-CutoverRecord 'stop-intent.json' @{phase='STOPPING_LEGACY';roles=$fresh}
        # The original controller enforces ownership and graceful drain. Do not
        # ask the retired runtime to be Ready or authenticate an old MCP session.
        $null=Invoke-CutoverScript (Join-Path $legacy 'codex_bridge\scripts\runtime-control.ps1') '-Action ShutdownRuntime'
    } else {
        Write-CutoverRecord 'already-stopped.json' @{legacyRuntimePresent=$false;shutdownInvoked=$false}
    }
    Invoke-CutoverOwner Stopped
}
function Retire-CutoverStartup([string]$Shortcut,[string]$Backup,[string]$Retired) {
    & $module {param($paths) foreach($p in $paths){Assert-DailyPath $p}} @($Shortcut,$Backup,$Retired)
    if((Get-FileHash -LiteralPath $Shortcut).Hash -cne (Get-FileHash -LiteralPath $Backup).Hash){throw 'CUTOVER_STARTUP_CHANGED'}
    if(Test-Path -LiteralPath $Retired){throw 'CUTOVER_STARTUP_RETIRE_EXISTS'}
    [IO.File]::Move($Shortcut,$Retired)
    if((Test-Path -LiteralPath $Shortcut) -or (Get-FileHash -LiteralPath $Retired).Hash -cne (Get-FileHash -LiteralPath $Backup).Hash){throw 'CUTOVER_STARTUP_RETIRE_UNKNOWN'}
}
function Test-CutoverTrayExitSignal([int]$TrayId,[string]$OperatorSid) {
    $process=Get-Process -Id $TrayId -ErrorAction Stop;$signal=$null
    try {
        $null=$process.Handle
        $cim=Get-CimInstance Win32_Process -Filter "ProcessId=$TrayId"
        $sid=Invoke-CimMethod -InputObject $cim -MethodName GetOwnerSid
        $entry=$legacy+'\mcp_control_center\scripts\tray.ps1'
        if($process.Path -ine $ps -or $sid.ReturnValue -ne 0 -or $sid.Sid -cne $OperatorSid -or
            $cim.CommandLine -notmatch ('(?i)-File\s+"'+[regex]::Escape($entry)+'"(?:\s|$)') -or
            $cim.CommandLine -match '(?i)-(Command|EncodedCommand)\b'){throw 'CUTOVER_TRAY_OWNER_UNKNOWN'}
        $name='Local\McpCc.InstalledTrayExit.v1.'+$TrayId+'.'+$process.StartTime.ToUniversalTime().Ticks
        try {$signal=[Threading.EventWaitHandle]::OpenExisting($name,[Security.AccessControl.EventWaitHandleRights]::Modify -bor [Security.AccessControl.EventWaitHandleRights]::ReadPermissions)}
        catch [Threading.WaitHandleCannotBeOpenedException] {return $false}
        $acl=$signal.GetAccessControl();$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
        if(-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $OperatorSid -or $rules.Count -ne 2){throw 'CUTOVER_TRAY_SIGNAL_REJECTED'}
        foreach($rule in $rules){
            if($rule.IsInherited -or $rule.EventWaitHandleRights -ne [Security.AccessControl.EventWaitHandleRights]::FullControl -or
                -not (($rule.IdentityReference.Value -ceq $OperatorSid -and $rule.AccessControlType -eq 'Allow') -or
                ($rule.IdentityReference.Value -ceq 'S-1-5-2' -and $rule.AccessControlType -eq 'Deny'))){throw 'CUTOVER_TRAY_SIGNAL_REJECTED'}
        }
        return $true
    }finally{if($signal){$signal.Dispose()};$process.Dispose()}
}
function Wait-CutoverManualTrayExit([int]$TrayId) {
    # Capability absence is not an ACL denial. The ordinary UI is the original owner.
    # The operator explicitly confirmed this handoff before the core was stopped.
    $process=Get-Process -Id $TrayId -ErrorAction Stop
    try {
        $null=$process.Handle
        Write-Host '[CLOSE_CC_NOW] Bridge/Tunnel 已安全停止。現在請在舊 Control Center 托盤選 Exit control center only。腳本最多等待 120 秒；不要關閉此 PowerShell。'
        if(-not $process.WaitForExit(120000)){throw 'CUTOVER_MANUAL_TRAY_EXIT_NOT_COMPLETED'}
        $mutex=$null
        try{$mutex=[Threading.Mutex]::OpenExisting('Local\McpControlCenterTray');throw 'CUTOVER_TRAY_STILL_PRESENT'}
        catch [Threading.WaitHandleCannotBeOpenedException] {}finally{if($mutex){$mutex.Dispose()}}
    }finally{$process.Dispose()}
}

function Request-CutoverTrayExit([int]$TrayId,[string]$OperatorSid) {
    if(-not(Test-CutoverTrayExitSignal $TrayId $OperatorSid)){throw 'CUTOVER_TRAY_SIGNAL_UNAVAILABLE'}
    $process=Get-Process -Id $TrayId -ErrorAction Stop;$signal=$null
    try {
        $null=$process.Handle
        $name='Local\McpCc.InstalledTrayExit.v1.'+$TrayId+'.'+$process.StartTime.ToUniversalTime().Ticks
        $signal=[Threading.EventWaitHandle]::OpenExisting($name,[Security.AccessControl.EventWaitHandleRights]::Modify)
        if($process.HasExited -or -not $signal.Set() -or -not $process.WaitForExit(30000)){throw 'CUTOVER_TRAY_EXIT_UNKNOWN'}
    }finally{if($signal){$signal.Dispose()};$process.Dispose()}
}
function Assert-CutoverCcOwner($Layout,[string]$OperatorSid) {
    Assert-McpCcDeploymentSelected $Layout
    $trayFile=Join-Path $Layout.stateRoot 'tray.pid'
    $trayId=[int][IO.File]::ReadAllText($trayFile).Trim()
    $info=Get-CimInstance Win32_Process -Filter "ProcessId=$trayId" -ErrorAction Stop
    if($null -eq $info){throw 'CUTOVER_CC_OWNER_UNKNOWN'}
    $entry=Join-Path $Layout.managerRoot 'scripts\tray.ps1'
    $pattern='(?i)^"?'+[regex]::Escape($ps)+'"?\s+-NoProfile\s+-WindowStyle\s+Hidden\s+-File\s+"'+[regex]::Escape($entry)+'"\s*$'
    $sid=Invoke-CimMethod -InputObject $info -MethodName GetOwnerSid -ErrorAction Stop
    if($info.ExecutablePath -ine $ps -or $info.CommandLine -notmatch $pattern -or $sid.ReturnValue -ne 0 -or
        $sid.Sid -cne $OperatorSid -or $info.SessionId -ne (Get-Process -Id $PID).SessionId){throw 'CUTOVER_CC_OWNER_UNKNOWN'}
    $mutex=[Threading.Mutex]::OpenExisting('Local\McpControlCenterTray');$mutex.Dispose()
    return $trayId
}
function Start-CutoverControlCenter($Layout,[string]$OperatorSid) {
    Assert-McpCcDeploymentSelected $Layout
    $launcher=Join-Path $ccSource 'scripts\start-runtime-tray.vbs'
    $child=Start-Process 'C:\Windows\System32\wscript.exe' -ArgumentList ('"'+$launcher+'"') -WindowStyle Hidden -PassThru
    try {
        $deadline=[DateTime]::UtcNow.AddSeconds(45)
        do {
            if($child.HasExited){throw 'CUTOVER_CC_LAUNCH_FAILED'}
            $file=Join-Path $Layout.stateRoot 'tray.pid'
            if(Test-Path -LiteralPath $file){
                $id=[int][IO.File]::ReadAllText($file).Trim()
                if($null -ne (Get-Process -Id $id -ErrorAction SilentlyContinue)){
                    $null=Assert-CutoverCcOwner $Layout $OperatorSid
                    return
                }
            }
            Start-Sleep -Milliseconds 250
        }while([DateTime]::UtcNow -lt $deadline)
        throw 'CUTOVER_CC_START_UNKNOWN'
    }finally{$child.Dispose()}
}
function Assert-CutoverCcReady($Layout,[string]$OperatorSid) {
    $null=Assert-CutoverCcOwner $Layout $OperatorSid
    $core=Import-Module (Join-Path $Layout.managerRoot 'src\McpControlCenter.Core.psm1') -PassThru -Force
    $status=& $core {
        $manifest=Read-McpCcManifest
        $component=Get-McpCcComponent -Manifest $manifest -Id codex_bridge
        Get-McpCcComponentStatus -Component $component -TimeoutSeconds 5
    }
    if($status.localStatus -cne 'Ready' -or @($status.probes|Where-Object {-not $_.success}).Count){throw 'CUTOVER_CC_PROBE_FAILED'}
}

try {
    $lock=& $module {param($r) Open-DailyLock $r} $root
    if($RecoverAfterReboot){
        if($Inspect){throw 'CUTOVER_RECOVERY_INSPECT_CONFLICT'}
        if(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'DAILY_NON_ADMIN_REQUIRED'}
        Assert-CutoverIndependent 0
        $null=& $module {param($r,$name) Resolve-DailyCutoverAfterReboot $r $name} $root $RecoverAfterReboot
    }
    & $module {param($r) Assert-DailyNoPending $r} $root
    $manifest=& $module {param($r,$v) Test-DailyVersion $r $v} $root $Version
    $ccLayout=Test-McpCcDeploymentVersion (Join-Path $ccSource 'Runtime') $ControlCenterVersion
    $ops=Join-Path $root $(if($Inspect){'inspections'}else{'operations'})
    [void][IO.Directory]::CreateDirectory($ops)
    $op=Join-Path $ops ('cutover-'+[guid]::NewGuid().ToString('N'));[void][IO.Directory]::CreateDirectory($op)
    Write-CutoverRecord 'intent.json' @{version=$Version;controlCenterVersion=$ControlCenterVersion;inspect=[bool]$Inspect;utc=[DateTime]::UtcNow.ToString('o');manifestFiles=@($manifest.files).Count;
        cutoverScriptSha256=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash;
        deploymentModuleSha256=(Get-FileHash -LiteralPath $module.Path -Algorithm SHA256).Hash;
        recoveredOperation=$RecoverAfterReboot;programFilesWrites=$false;dataMoved=$false}
    if(Test-Path -LiteralPath (Join-Path $root 'current.json')){throw 'CUTOVER_ALREADY_ADOPTED_USE_START'}
    if(Test-Path -LiteralPath (Join-Path $ccSource 'Runtime\current.json')){throw 'CUTOVER_CC_ALREADY_SELECTED'}
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    if(([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'DAILY_NON_ADMIN_REQUIRED'}
    $ownerRoot='C:\GPT_MCPtool\mcp_control_center\.local\runtime'
    $roles=@(Get-CutoverOwnedRoles $ownerRoot $identity.User.Value)
    . (Join-Path $release 'codex_bridge\scripts\daily-runtime-settings.ps1')
    $settings=Read-CbDailySettings $release
    if($settings.ownerRoot -ine $ownerRoot -or @($roles|Where-Object {$_.runtimeDir -ine $settings.bridgeRuntimeDir}).Count){throw 'CUTOVER_SETTINGS_CHANGED'}
    $shortcut=Join-Path ([Environment]::GetFolderPath('Startup')) 'MCP Control Center.lnk'
    $shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut($shortcut)
    if(-not(Test-Path -LiteralPath $shortcut) -or $link.TargetPath -ine 'C:\Windows\System32\wscript.exe' -or
        $link.Arguments -cne ('"'+$legacy+'\mcp_control_center\scripts\start-tray.vbs"')){throw 'CUTOVER_STARTUP_CHANGED'}
    $trayId=0;$trayExitSignal=$false;$trayPresent=$false;$trayMutex=$null
    try{$trayMutex=[Threading.Mutex]::OpenExisting('Local\McpControlCenterTray');$trayPresent=$true}
    catch [Threading.WaitHandleCannotBeOpenedException]{}finally{if($trayMutex){$trayMutex.Dispose()}}
    if($trayPresent){
        $trayId=[int][IO.File]::ReadAllText((Join-Path $ownerRoot 'tray.pid')).Trim()
        $tray=Get-CimInstance Win32_Process -Filter "ProcessId=$trayId"
        if($null -eq $tray -or $tray.CommandLine -notmatch [regex]::Escape($legacy+'\mcp_control_center\scripts\tray.ps1')){throw 'CUTOVER_TRAY_OWNER_UNKNOWN'}
        $trayExitSignal=Test-CutoverTrayExitSignal $trayId $identity.User.Value
    }elseif($roles.Count){throw 'CUTOVER_LEGACY_CONTROLLER_OWNER_ABSENT'}
    $coreId=0;foreach($role in $roles){if($role.role -ceq 'server'){$coreId=$role.pid}}
    $selfHosted=$false;try{Assert-CutoverIndependent $coreId}catch{$selfHosted=$true}
    Write-CutoverRecord 'observation.json' @{legacyReadinessRequired=$false;roles=$roles;trayPid=$trayId;trayMutex=$trayPresent;trayExitSignal=$trayExitSignal;independent=(-not $selfHosted);
        approvalLock=(Test-Path -LiteralPath (Join-Path $settings.dataDir 'powershell-approval\approval.lock'));
        startup=@{path=$shortcut;target=$link.TargetPath;arguments=$link.Arguments;workingDirectory=$link.WorkingDirectory};settings=$settings}
    Copy-Item -LiteralPath $shortcut -Destination (Join-Path $op 'startup.before.lnk')
    if($Inspect){
        $blockers=@()
        if($selfHosted){$blockers+='CUTOVER_INDEPENDENT_OPERATOR_REQUIRED'}
        if($trayPresent -and -not $trayExitSignal){$blockers+='LEGACY_TRAY_EXIT_EVENT_ABSENT_MANUAL_UI_REQUIRED'}
        Write-CutoverRecord 'terminal.json' @{phase='INSPECTED';blockers=$blockers;credentialsRead=$false;runtimeChanged=$false}
        @{phase='INSPECTED';blockers=$blockers;receipt=$op}|ConvertTo-Json;exit 0
    }
    Assert-CutoverIndependent $coreId
    $phase='PREFLIGHT'
    Invoke-CutoverOwner Preflight
    # Installed shutdown requires its selected Tray alive. Obtain local readiness
    # before stopping; never retire the Tray ahead of its controller's shutdown.
    if($trayPresent -and -not $trayExitSignal){
        $answer=Read-Host '[KEEP_CC_OPEN] 新版準備完成。輸入 EXIT 後會停止仍在執行的舊程序；只有看到 [CLOSE_CC_NOW] 才關閉舊 CC。其他輸入取消'
        if($answer -cne 'EXIT'){throw 'CUTOVER_MANUAL_TRAY_NOT_READY'}
    }
    # Stop only through the original authenticated owner; no alternate channel on refusal.
    $phase='STOPPING_LEGACY'
    Stop-CutoverLegacy $roles $ownerRoot $identity.User.Value;$oldStopped=$true
    $phase='RETIRING_TRAY'
    if($trayPresent){
        if($trayExitSignal){Request-CutoverTrayExit $trayId $identity.User.Value}
        else {Wait-CutoverManualTrayExit $trayId}
    }
    $phase='RETIRING_STARTUP'
    Retire-CutoverStartup $shortcut (Join-Path $op 'startup.before.lnk') (Join-Path $op 'startup.retired.lnk')
    $startupChanged=$true
    $phase='ADOPTING'
    $null=& $module {param($r,$v) Test-DailyVersion $r $v} $root $Version
    $ccLayout=Test-McpCcDeploymentVersion (Join-Path $ccSource 'Runtime') $ControlCenterVersion
    Invoke-CutoverOwner Stopped
    $absent=$false;$m=$null
    try{$m=[Threading.Mutex]::OpenExisting('Local\McpControlCenterTray')}catch [Threading.WaitHandleCannotBeOpenedException]{$absent=$true}finally{if($m){$m.Dispose()}}
    if(-not $absent){throw 'DAILY_LEGACY_TRAY_PRESENT'}
    & $module {param($r,$v)
        Write-DailyNew (Join-Path $r 'adoption.json') @{contract='mcpcc-daily-adoption-v1';settingsSha256=(Get-DailyDigest (Join-Path $r 'settings.json'));version=$v}
        Set-DailySelector $r $v
    } $root $Version
    $selected=$true
    $null=Set-McpCcDeploymentSelection $ccSource $ControlCenterVersion
    $phase='STARTING_NEW';Invoke-CutoverOwner Start
    Start-CutoverControlCenter $ccLayout $identity.User.Value
    $phase='VERIFYING_NEW';Invoke-CutoverOwner Ready
    Assert-CutoverCcReady $ccLayout $identity.User.Value
    $phase='SWITCHING_STARTUP'
    if(Test-Path -LiteralPath $shortcut){throw 'CUTOVER_STARTUP_CHANGED'}
    $next=Join-Path $op 'startup.next.lnk';$new=$shell.CreateShortcut($next)
    $new.TargetPath='C:\Windows\System32\wscript.exe';$new.Arguments='"C:\GPT_MCPtool\mcp_control_center\scripts\start-runtime-tray.vbs" --boot'
    $new.WorkingDirectory=$ccSource;$new.Description='MCP Control Center independent runtime';$new.Save()
    [IO.File]::Move($next,$shortcut)
    $final=$shell.CreateShortcut($shortcut)
    if($final.TargetPath -ine $new.TargetPath -or $final.Arguments -cne $new.Arguments -or $final.WorkingDirectory -ine $new.WorkingDirectory){throw 'CUTOVER_STARTUP_VERIFY_FAILED'}
    Invoke-CutoverOwner Ready
    Assert-CutoverCcReady $ccLayout $identity.User.Value
    Write-CutoverRecord 'terminal.json' @{phase='ACCEPTED';version=$Version;controlCenterVersion=$ControlCenterVersion;health=(Get-CutoverHealth);startupChanged=$true;dataMoved=$false;
        anonymousMcp=401;authenticatedMcp='initialize PASS';protectedHost='UNVERIFIED';coldLogin='UNVERIFIED';otherMcpReconcile=$false}
    @{phase='ACCEPTED';version=$Version;receipt=$op}|ConvertTo-Json
}catch {
    $code=([string]$_.Exception.Message -split ':')[0]
    $cause=$_.Exception.GetBaseException()
    if($code -cnotmatch '^[A-Z][A-Z0-9_]+$'){
        $code=if($cause -is [UnauthorizedAccessException]){'CUTOVER_OS_ACCESS_DENIED'}else{'CUTOVER_FAILED'}
    }
    if($op){
        Write-CutoverRecord 'failure.json' @{phase=$phase;code=$code;exceptionType=$cause.GetType().FullName;hresult=$cause.HResult;oldStopped=$oldStopped;selected=$selected;startupChanged=$startupChanged}
        # Never replay an uncertain stop or silently restart Program Files.
        $terminal=if($phase -in @('INSPECTING','PREFLIGHT')){'REJECTED'}else{'UNKNOWN'}
        Write-CutoverRecord 'terminal.json' @{phase=$terminal;code=$code;legacyStartupBackup='startup.before.lnk';automaticRetry=$false}
    }
    @{phase='BLOCKED';at=$phase;code=$code;receipt=$op;oldStopped=$oldStopped;selected=$selected;
        exceptionType=$cause.GetType().FullName;hresult=$cause.HResult;sourceLine=$_.InvocationInfo.ScriptLineNumber}|ConvertTo-Json
    exit 1
}finally{if($lock){$lock.Dispose()}}
