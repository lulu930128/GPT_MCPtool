param(
    [ValidateSet('Synthetic','LegacyCutover','NativeOperator','NativeEvent','NativeTray')][string]$Mode='Synthetic',
    [string]$FixtureRoot
)
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$workspace=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$operatorPath=Join-Path $workspace 'codex_bridge\scripts\installed-release-operator.ps1'
$trayPath=Join-Path $workspace 'mcp_control_center\scripts\tray.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($operatorPath,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'OPERATOR_PARSE_FAILED'}
$trayAst=[Management.Automation.Language.Parser]::ParseFile($trayPath,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'TRAY_PARSE_FAILED'}
function Load-Function($Tree,[string]$Name){
    $node=$Tree.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $Name},$true)
    if(-not $node){throw ('MISSING_FUNCTION: '+$Name)}
    [scriptblock]::Create($node.Extent.Text)
}
foreach($name in @('Assert-IndependentOperator','Open-UpgradeTrayHandoff','Wait-UpgradeTrayExit','Assert-UpgradeRuntimeStopped','Wait-UpgradeRuntimeStopped','Get-UpgradeResumeReceipt','Read-BoundedJson','Write-Receipt')){
    . (Load-Function $ast $name)
}
foreach($name in @('New-TrayExitSignal','Initialize-TrayExitSignal','Request-TrayExit','Complete-TrayExit','Get-TrayControllerState','Test-TrayMaintenanceBusy')){
    . (Load-Function $trayAst $name)
}
$checks=0
function Check([bool]$Value,[string]$Message){if(-not $Value){throw ('CHECK_FAILED: '+$Message)};$script:checks++}
function Refused([scriptblock]$Body,[string]$Code){$actual='';try{& $Body|Out-Null}catch{$actual=$_.Exception.Message};Check ($actual -ceq $Code) "Expected $Code; got $actual"}
$utf8=[Text.UTF8Encoding]::new($false)
$ps=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$operator=[pscustomobject]@{sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value}
$Action='Cutover';$InstalledRecoverySha256='';$manager=Join-Path $workspace 'mcp_control_center'

function Reset-Tray {
    $script:Closing=$false;$script:ExitRequested=$false;$script:ExitClock=$null
    $script:ControllerProcess=$null;$script:WorkspaceLocalOwner=$null;$script:WorkspaceLocalWorker=$null
    $script:SelfReloadWorker=$null;$script:SelfReloadShutdown=$null;$script:NormalOperatorWorker=$null
    $script:PendingRestartMcp=$null;$script:PendingAction=$null;$script:PendingLabel=$null
    $script:UpgradeExitSignal=$null
    $script:manifest=@{installedRelease=@{state=@{operatorSid=$operator.sid}}}
    $script:timer=[pscustomobject]@{}
    $script:timer|Add-Member ScriptMethod Stop {}
    $script:notifyIcon=[pscustomobject]@{Visible=$true}
}
function Set-TrayRestartFeedback {param($Message,[switch]$Warning) $script:exitRefused=$true}
function Show-Warning {param($Message) throw 'MODAL_EXIT_NOT_ALLOWED'}
function Update-TrayControllerLifecycle {Complete-TrayExit}
function Show-TrayControllerWarning {}

if($Mode -notin @('Synthetic','LegacyCutover')){
    # Explicit independent OS fixture entry. Never dot-source the operator/tray
    # entrypoints, import installed config, acquire production mutexes or read stores.
    $fixture=[IO.Path]::GetFullPath($FixtureRoot)
    if((Split-Path -Parent $fixture) -ine [IO.Path]::GetTempPath().TrimEnd('\') -or
        (Split-Path -Leaf $fixture) -cnotmatch '^installed-handoff-native-[0-9a-f]{32}$' -or
        -not (Test-Path -LiteralPath (Join-Path $fixture 'fixture-only'))){throw 'NATIVE_FIXTURE_ROOT_REJECTED'}
    Add-Type -Path (Join-Path $manager 'src\RemoteSelfReload.Native.cs')
    $fixturePrefix='Local\McpCc.InstalledTrayExit.fixture.'+(Split-Path -Leaf $fixture)+'.'
    if($Mode -eq 'NativeTray'){
        Add-Type -AssemblyName System.Windows.Forms
        Reset-Tray
        # Only the event namespace is replaced for this random fixture. Constructor,
        # ACL, collision handling and disposal remain the production function body.
        $createSignal=(Load-Function $trayAst 'New-TrayExitSignal').ToString().Replace('Local\McpCc.InstalledTrayExit.v1.',$fixturePrefix)
        . ([scriptblock]::Create($createSignal))
        function Stop-TrayApplication {[Windows.Forms.Application]::Exit()}
        $script:timer=[Windows.Forms.Timer]::new();$script:timer.Interval=50
        $script:UpgradeExitSignal=New-TrayExitSignal
        [IO.File]::WriteAllText((Join-Path $fixture 'tray.pid'),[string]$PID,$utf8)
        $clock=[Diagnostics.Stopwatch]::StartNew()
        $script:timer.add_Tick({
            if($clock.Elapsed.TotalSeconds -ge 20){[Windows.Forms.Application]::Exit();return}
            if($script:UpgradeExitSignal.WaitOne(0)){Request-TrayExit -NonInteractive}
        })
        try {$script:timer.Start();[Windows.Forms.Application]::Run()}
        finally {$script:UpgradeExitSignal.Dispose();$script:timer.Dispose()}
        exit 0
    }
    $resultPath=Join-Path $fixture 'native-result.json'
    $child=$null;$nativeHandoff=$null
    try {
        # NativeEvent tests only the OS event primitive in the current job context.
        # NativeOperator additionally requires the ORIGINAL independent guard.
        if($Mode -eq 'NativeOperator'){Assert-IndependentOperator}
        $before=[Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks
        $child=Start-Process -FilePath $ps -ArgumentList ('-NoProfile -NonInteractive -File "'+$PSCommandPath+'" -Mode NativeTray -FixtureRoot "'+$fixture+'"') -WindowStyle Hidden -PassThru
        $deadline=[Diagnostics.Stopwatch]::StartNew()
        while(-not (Test-Path -LiteralPath (Join-Path $fixture 'tray.pid'))){
            if($child.HasExited -or $deadline.Elapsed.TotalSeconds -gt 10){throw 'FIXTURE_TRAY_START_FAILED'}
            Start-Sleep -Milliseconds 50
        }
        $verifier=New-Module {function Assert-McpCcInstalledPrivatePath {param($p,$s)}}
        function Get-McpCcInstalledBridgeBinding {param($root) @{ownerRoot=$fixture}}
        function Assert-McpCcInstalledSelection {param($binding)
            $cim=Get-CimInstance Win32_Process -Filter "ProcessId=$($child.Id)" -ErrorAction Stop
            $sid=Invoke-CimMethod -InputObject $cim -MethodName GetOwnerSid -ErrorAction Stop
            if($child.HasExited -or $sid.Sid -cne $operator.sid -or $cim.CommandLine -notlike ('*'+$PSCommandPath+'*NativeTray*'+$fixture+'*')){throw 'FIXTURE_OWNER_CHANGED'}
        }
        function Assert-NoTray {if(-not $child.HasExited){throw 'FIXTURE_TRAY_STILL_ALIVE'}}
        # The random namespace prevents any production signal from being opened.
        $null=$child.Handle
        $eventName=$fixturePrefix+$child.Id+'.'+$child.StartTime.ToUniversalTime().Ticks
        $event=[Threading.EventWaitHandle]::OpenExisting($eventName,
            [Security.AccessControl.EventWaitHandleRights]::Modify -bor [Security.AccessControl.EventWaitHandleRights]::ReadPermissions)
        try {
            $acl=$event.GetAccessControl();$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
            Check ($acl.AreAccessRulesProtected -and $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq $operator.sid) 'native event has protected same-user owner ACL'
            Check ($rules.Count -eq 2) 'native event has exactly two explicit rules'
            foreach($rule in $rules){
                Check (-not $rule.IsInherited -and $rule.EventWaitHandleRights -eq [Security.AccessControl.EventWaitHandleRights]::FullControl) 'native rights and inheritance'
                Check (($rule.IdentityReference.Value -ceq $operator.sid -and [string]$rule.AccessControlType -ceq 'Allow') -or
                    ($rule.IdentityReference.Value -ceq 'S-1-5-2' -and [string]$rule.AccessControlType -ceq 'Deny')) 'only same user allowed; network logons denied'
            }
            Assert-McpCcInstalledSelection @{}
            Check ($event.Set()) 'native Set accepted'
            Check ($child.WaitForExit(10000) -and $child.ExitCode -eq 0) 'real WaitOne invokes ordinary fixture tray Exit'
        } finally {$event.Dispose()}
        $reopened=$null;$closed=$false
        try {$reopened=[Threading.EventWaitHandle]::OpenExisting($eventName)}catch [Threading.WaitHandleCannotBeOpenedException]{$closed=$true}
        finally {if($reopened){$reopened.Dispose()}}
        Check $closed 'disposing both endpoints removes the fixture event'
        if($Mode -eq 'NativeOperator'){Assert-IndependentOperator}
        Check ($before -eq [Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks) 'same fixture caller survives disposable process exit'
        $result=@{ok=$true;checks=$checks;operatorPid=$PID;trayPid=$child.Id;outsideJobs=[McpCcReloadNative]::OutsideAllJobs();scope=$Mode;independentOperatorVerified=($Mode -eq 'NativeOperator');installedAclAcceptance='NOT_TESTED';productionTouched=$false}
    } catch {$result=@{ok=$false;error=$_.Exception.Message;productionTouched=$false}}
    finally {
        if($nativeHandoff){$nativeHandoff.signal.Dispose();$nativeHandoff.process.Dispose()}
        if($child){$child.Dispose()} # fixture child has its own bounded natural exit
    }
    [IO.File]::WriteAllText($resultPath,($result|ConvertTo-Json),$utf8)
    if(-not $result.ok){exit 1};exit 0
}

# Synthetic lifecycle boundary: execute the actual Cutover try/catch/finally,
# ordinary Startup writer on a TEMP .lnk, actual phase writer and resume checks.
# Only external controllers, protected installation observations and process IO
# are synthetic. No production action or operator top-level entry is invoked.
Add-Type -TypeDefinition @'
public static class McpCcReloadNative {
    public static bool Outside = true;
    public static bool OutsideAllJobs() { return Outside; }
    public static bool OutsideJobs(object process) { return Outside; }
}
'@
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('installed-auto-resume-'+[guid]::NewGuid().ToString('N'))
if($Mode -eq 'LegacyCutover'){
    $fixture=[IO.Path]::GetFullPath($FixtureRoot)
    if((Split-Path -Parent $fixture) -ine [IO.Path]::GetTempPath().TrimEnd('\') -or (Split-Path -Leaf $fixture) -cnotmatch '^installed-auto-resume-[0-9a-f]{32}$'){throw 'FIXTURE_ROOT_REJECTED'}
}
[void][IO.Directory]::CreateDirectory($fixture)
$verifier=New-Module {
    function Assert-McpCcNoReparseChain {param($p)}
    function Assert-McpCcInstalledPrivatePath {param($p,$s)}
}
$cutover=$ast.Find({param($n)$n -is [Management.Automation.Language.TryStatementAst] -and
    $n.Body.Extent.Text.Contains("if(`$Action -eq 'Cutover')") -and $n.Body.Extent.Text.Contains('Wait-UpgradeTrayExit $handoff')},$true)
Check ($null -ne $cutover) 'unique production Cutover body is exercised'
$cutoverBlock=[scriptblock]::Create($cutover.Extent.Text)
$realOpen=${function:Open-UpgradeTrayHandoff}
function Open-UpgradeTrayHandoff {param($previous)
    $script:trace.Add('open')
    if($script:scenario -eq 'legacy'){throw 'LEGACY_MUST_NOT_OPEN_EVENT'}
    if($script:scenario -eq 'unavailable'){throw 'UPGRADE_TRAY_EXIT_UNAVAILABLE'}
    return $script:fixtureHandoff
}
function Get-UpgradeListeners {if($script:scenario -eq 'listener') {[pscustomobject]@{Port=18828}}}
function Assert-NoTray {if(-not $script:fixtureProcess.exited){throw 'CLOSE_CONTROL_CENTER_UI_ONLY_THEN_REPEAT'}}
function Assert-OwnerMigrationSourceUnchanged {param($r,$p,[switch]$StoppedUpgrade)
    $script:trace.Add('binding:'+ [string][bool]$StoppedUpgrade)
    if($StoppedUpgrade -and $script:scenario -eq 'binding'){throw 'UPGRADE_BASELINE_CHANGED'}
}
function Assert-McpCcInstalledClosure {param($r) $script:trace.Add('closure');if($script:scenario -eq 'hash'){throw 'INSTALLED_TREE_HASH_MISMATCH'}}
function Get-CutoverBaselineRoot {param($r,$p,$ExpectedAttestationSha256) $script:baselineRoot}
function Get-McpCcInstalledBridgeBinding {param($p) @{}}
function Assert-RemoteReceiptsTerminal {param($p) $script:trace.Add('terminal')}
function Assert-McpCcInstalledSelection {param($b) $script:trace.Add('selected')}
function Assert-OwnedReady {param($r,$health) if($script:scenario -eq 'foreign-owner'){throw 'OWNER_UNVERIFIED'}}
function Assert-HttpAuthentication {param($Release)}
function Get-Health {param([switch]$Idle) @{pid=90103;buildId='2222222222222222'}}
function Invoke-WebRequest {param($UseBasicParsing,$TimeoutSec,$MaximumRedirection,[Parameter(Position=0)]$Uri) @{StatusCode=200;Content='ready'}}
function Start-SelectedTray {param($root) $script:trace.Add('start-tray');return 90105}
function Invoke-Controller {param($root,$verb)
    $script:trace.Add($verb)
    if($verb -eq 'ShutdownRuntime'){
        Check (-not $script:fixtureProcess.exited -and -not $script:fixtureHandoff.sent) 'controller stops before old tray exit'
        if($script:scenario -eq 'shutdown'){throw 'CONTROLLER_UNKNOWN_DO_NOT_RETRY'}
        $script:runtimeStopped=$true
        return @{after=@{server=@{ownership='Stopped'};tunnel=@{ownership='Stopped'}}}
    }
    return @{after=@{tunnel=@{pid=$(if($verb -eq 'Status'){90102}else{90104})}}}
}
function Get-Process {param([int]$Id)
    if($Id -in @(90101,90102) -and $script:runtimeStopped){
        if($script:scenario -eq 'process-unknown'){throw 'ACCESS_DENIED_FIXTURE'}
        if($script:scenario -eq 'foreign-pid'){return [pscustomobject]@{Handle=1;HasExited=$false;StartTime=[datetime]::UtcNow}|Add-Member ScriptMethod Dispose {} -PassThru}
        if($script:scenario -eq 'delayed' -and $script:exitObservations++ -lt 2){return [pscustomobject]@{Handle=1;HasExited=$false;StartTime=$script:oldStart}|Add-Member ScriptMethod Dispose {} -PassThru}
        $err=[Management.Automation.ErrorRecord]::new([ArgumentException]::new('fixture absent'),'NoProcessFoundForGivenId,Microsoft.PowerShell.Commands.GetProcessCommand',[Management.Automation.ErrorCategory]::ObjectNotFound,$Id)
        throw $err
    }
    [pscustomobject]@{Path=$ps;StartTime=$script:oldStart;SessionId=1}
}
function Stop-TrayApplication {$script:fixtureProcess.exited=$true;$script:trace.Add('tray-exited')}
function Reset-Cutover([string]$Scenario){
    Reset-Tray
    $script:scenario=$Scenario;$script:trace=[Collections.Generic.List[string]]::new()
    $script:runtimeStopped=$false;$script:exitObservations=0;$script:exitRefused=$false
    $script:oldStart=[datetime]::UtcNow.AddMinutes(-5)
    $script:runtime=Join-Path $fixture $Scenario;[void][IO.Directory]::CreateDirectory($script:runtime)
    $script:startup=Join-Path $script:runtime 'startup.lnk';$script:backup=Join-Path $script:runtime 'legacy-startup.lnk'
    [IO.File]::WriteAllText($script:startup,'fixture original shortcut',$utf8)
    $script:receiptPath=Join-Path $script:runtime 'operator-cutover.json'
    $script:ReleaseRoot=Join-Path $script:runtime 'new';$script:baselineRoot=Join-Path $script:runtime 'old'
    $script:legacyBridge=Join-Path $script:baselineRoot 'codex_bridge';$script:legacyCc=Join-Path $script:baselineRoot 'mcp_control_center'
    $script:owner=$script:runtime;$script:binding=@{};$script:baselineRelease=@{schemaVersion=6}
    $script:release=@{schemaVersion=6;releaseId='fixture-new';sourcePath=(Join-Path $script:runtime 'manifest.json');cutover=@{rollbackBuildId='1111111111111111';legacyStartupSha256=(Get-FileHash $script:startup).Hash.ToLowerInvariant()}}
    [IO.File]::WriteAllText($script:release.sourcePath,'fixture manifest',$utf8)
    $script:autoResumeManifestHash=(Get-FileHash $script:release.sourcePath).Hash.ToLowerInvariant()
    $script:h=@{pid=90101;buildId='1111111111111111'}
    $script:AutoResume=$true;$script:isInstalledUpgrade=$true;$script:resumeUpgrade=$false;$script:handoff=$null
    $script:lock=[Threading.Mutex]::new($false,('Local\InstalledHandoffFixture.'+[guid]::NewGuid().ToString('N')));$script:acquired=$false
    $script:fixtureProcess=[pscustomobject]@{exited=$false;StartTime=$script:oldStart;disposed=$false}
    $script:fixtureProcess|Add-Member ScriptProperty HasExited {$this.exited}
    $script:fixtureProcess|Add-Member ScriptMethod WaitForExit {param($ms)
        Check ($ms -eq 30000) 'tray wait is bounded'
        $script:trace.Add('wait-exit')
        if($script:scenario -eq 'startup'){[IO.File]::WriteAllText($script:startup,'changed',$utf8)}
        if($script:scenario -eq 'manifest'){[IO.File]::WriteAllText($script:release.sourcePath,'changed',$utf8)}
        return $this.exited
    }
    $script:fixtureProcess|Add-Member ScriptMethod Dispose {$this.disposed=$true}
    $signal=[pscustomobject]@{sets=0;disposed=$false}
    $signal|Add-Member ScriptMethod Set {
        $this.sets++;$script:trace.Add('event')
        $saved=Read-BoundedJson $script:receiptPath
        Check ($saved.phase -ceq 'UPGRADE_STOPPED' -and $script:runtimeStopped) 'event only follows durable UPGRADE_STOPPED'
        if($script:scenario -eq 'active'){$script:WorkspaceLocalWorker=@{pending=@{IsCompleted=$false}}}
        if($script:scenario -ne 'timeout'){Request-TrayExit -NonInteractive}
        return $true
    }
    $signal|Add-Member ScriptMethod Dispose {$this.disposed=$true}
    $script:fixtureHandoff=@{process=$script:fixtureProcess;signal=$signal;started=$script:oldStart.ToUniversalTime().Ticks;sent=$false}
}
if($Mode -eq 'LegacyCutover'){
    Reset-Cutover 'legacy';$AutoResume=$false
    & $cutoverBlock
    throw 'LEGACY_CUTOVER_MUST_EXIT_AT_STOPPED'
}
foreach($scenario in @('success','delayed','unavailable','foreign-owner','shutdown','active','timeout','startup','manifest','hash','binding','process-unknown','foreign-pid','listener')){
    Reset-Cutover $scenario
    $failure=''
    try {& $cutoverBlock|Out-Null}catch{$failure=$_.Exception.Message}
    if($scenario -in @('success','delayed')){
        Check ($failure -eq '') "$scenario Cutover failed: $failure"
        $saved=Read-BoundedJson $receiptPath
        Check ($failure -eq '' -and $saved.phase -ceq 'LOCAL_ACCEPTED') "$scenario reaches original LOCAL_ACCEPTED tail: $failure"
        Check ($saved.oldBuildId -cne $saved.newBuildId -and $saved.newBuildId -ceq '2222222222222222') 'different target Build is an ordinary upgrade'
        Check ($trace.IndexOf('ShutdownRuntime') -lt $trace.IndexOf('event') -and $trace.IndexOf('tray-exited') -lt $trace.IndexOf('EnsureRunning')) 'shutdown, exit, original target startup order'
        Check ($fixtureHandoff.signal.sets -eq 1) 'single exit signal'
        Check ($trace.IndexOf('binding:False') -lt $trace.IndexOf('ShutdownRuntime') -and $trace.IndexOf('binding:True') -gt $trace.IndexOf('tray-exited')) 'initial and stopped validation remain distinct'
    } elseif($scenario -in @('unavailable','foreign-owner')){
        Check (-not (Test-Path $receiptPath) -and -not $trace.Contains('ShutdownRuntime')) "$scenario refuses before any stop or cutover receipt"
    } else {
        $expected=@{shutdown='CONTROLLER_UNKNOWN_DO_NOT_RETRY';active='UPGRADE_TRAY_EXIT_TIMEOUT';timeout='UPGRADE_TRAY_EXIT_TIMEOUT';startup='UPGRADE_STARTUP_CHANGED';manifest='AUTO_RESUME_TARGET_CHANGED';hash='INSTALLED_TREE_HASH_MISMATCH';binding='UPGRADE_BASELINE_CHANGED';'process-unknown'='UPGRADE_PROCESS_STATE_UNKNOWN';'foreign-pid'='UPGRADE_FOREIGN_PID_PRESENT';listener='UPGRADE_RUNTIME_EXIT_TIMEOUT'}[$scenario]
        # Startup check can also reject at the shared receipt gate in this fixture.
        if($scenario -eq 'startup'){$expected='UPGRADE_STOP_RECEIPT_CHANGED'}
        Check ($failure -ceq $expected) "$scenario refuses with $expected; got $failure"
        $saved=Read-BoundedJson $receiptPath
        $phase=if($scenario -in @('active','timeout','listener')){'UPGRADE_STOPPED'}else{'UNKNOWN'}
        Check ($saved.phase -ceq $phase -and -not $trace.Contains('EnsureRunning')) "$scenario never starts target and retains $phase"
        if($scenario -eq 'listener'){Check ($fixtureHandoff.signal.sets -eq 0) 'runtime exit timeout does not request UI exit'}
        if($scenario -in @('active','timeout')){
            # Same command cannot re-send an event from a persisted stopped phase.
            $resumeUpgrade=$true;$lock=[Threading.Mutex]::new($false);$acquired=$false;$handoff=$null
            Refused {& $cutoverBlock} 'CLOSE_CONTROL_CENTER_UI_ONLY_THEN_REPEAT'
            Check ($fixtureHandoff.signal.sets -eq 1 -and (Read-BoundedJson $receiptPath).phase -ceq 'UPGRADE_STOPPED') 'timeout never replays and original manual resume remains possible'
            $fixtureProcess.exited=$true;$scenario='success';$script:scenario='success'
            $lock=[Threading.Mutex]::new($false);$acquired=$false
            & $cutoverBlock|Out-Null
            Check ((Read-BoundedJson $receiptPath).phase -ceq 'LOCAL_ACCEPTED') 'original stopped resume succeeds after confirmed UI exit'
        }
    }
}
# The original guard rejects a job-owned operator and Codex/App Server ancestry.
Reset-Cutover 'identity'
[McpCcReloadNative]::Outside=$false
Refused {Assert-IndependentOperator} 'INDEPENDENT_OPERATOR_REQUIRED'
[McpCcReloadNative]::Outside=$true
function Get-CimInstance {param($ClassName,$Filter)
    if($Filter -ceq "ProcessId=$PID"){return @{ParentProcessId=90001}}
    @{ParentProcessId=90002;Name='node.exe';CommandLine='node app-server'}
}
Refused {Assert-IndependentOperator} 'INDEPENDENT_OPERATOR_REQUIRED'
$lock.Dispose()
$legacyOutput=& $ps -NoProfile -NonInteractive -File $PSCommandPath -Mode LegacyCutover -FixtureRoot $fixture
Check ($LASTEXITCODE -eq 0) 'legacy Cutover exits successfully without AutoResume'
$legacyResult=($legacyOutput -join "`n")|ConvertFrom-Json
Check ($legacyResult.phase -ceq 'UPGRADE_STOPPED' -and (Read-BoundedJson (Join-Path $fixture 'legacy\operator-cutover.json')).phase -ceq 'UPGRADE_STOPPED') 'legacy two-stage command retains original output and durable stopped phase'
[pscustomobject]@{ok=$true;checks=$checks;fixture=$fixture;scope='synthetic Cutover and callback execution';nativeIndependence='separate NativeOperator fixture required';productionTouched=$false}|ConvertTo-Json
