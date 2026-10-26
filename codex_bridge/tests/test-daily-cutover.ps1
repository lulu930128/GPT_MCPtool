Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$passed=0
function Check([bool]$Value,[string]$Name){if(-not $Value){throw ('FAILED: '+$Name)};$script:passed++}
function Denied([scriptblock]$Body,[string]$Pattern){$code='';try{& $Body|Out-Null}catch{$code=$_.Exception.Message};Check ($code -match $Pattern) ($Pattern+' observed='+$code)}
function Read-Function([string]$File,[string]$Name) {
    $tokens=$null;$errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile($File,[ref]$tokens,[ref]$errors)
    Check (@($errors).Count -eq 0) ('parse '+[IO.Path]::GetFileName($File))
    $node=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $Name},$true)
    return [scriptblock]::Create($node.Extent.Text)
}
$core=Import-Module (Join-Path $repo 'mcp_control_center\src\McpControlCenter.Core.psm1') -PassThru -Force
$command=Get-Command Get-McpCcComponent
Check ($command.Parameters.ContainsKey('Id')) 'real CC module accepts Id'
Check (-not $command.Parameters.ContainsKey('ComponentId')) 'real CC module has no ComponentId alias'
$fixture=[pscustomobject]@{components=@([pscustomobject]@{id='codex_bridge';marker=42})}
$actual=Get-McpCcComponent -Manifest $fixture -Id codex_bridge
Check ($actual.marker -eq 42) 'real Get-McpCcComponent executes against fixture'
$manifest=Read-McpCcManifest
$bridge=Get-McpCcComponent -Manifest $manifest -Id codex_bridge
Check ($bridge.id -ceq 'codex_bridge' -and @($bridge.probes).Count -eq 2) 'real source registry resolves Bridge'
$owner=Get-Content -LiteralPath (Join-Path $repo 'codex_bridge\scripts\daily-code-owner.ps1') -Raw -Encoding UTF8
Check ($owner -notmatch 'Get-McpCcComponent|McpControlCenter|StartTray|ExitTray') 'Bridge owner has no CC lifecycle or readiness dependency'

. (Join-Path $repo 'codex_bridge\scripts\daily-bearer.ps1')
Denied {Assert-CbDailyMcpAuthentication ([pscustomobject]@{token=$null})} '^DAILY_BEARER_REQUIRED$'
Denied {Assert-CbDailyMcpAuthentication ([pscustomobject]@{token=' '})} '^DAILY_BEARER_REQUIRED$'
Denied {Assert-CbDailyBearerFile 'C:\not-the-existing-secret.dpapi' 'S-1-5-18'} '^DAILY_BEARER_SCOPE_REJECTED$'
Denied {Set-CbDailyContextBearer ([pscustomobject]@{token=$null}) ([pscustomobject]@{dataDir='C:\not-existing-state';operatorSid='S-1-5-18'})} '^DAILY_BEARER_SCOPE_REJECTED$'
$credential=Get-Content -LiteralPath (Join-Path $repo 'codex_bridge\scripts\daily-bearer.ps1') -Raw -Encoding UTF8
Check ($credential -notmatch 'Import-Module|Write-Host|Write-Output|Get-FileHash|ConvertFrom-SecureString|SetEnvironmentVariable') 'credential reader neither imports protected verifier nor emits/writes secret'
$settings=Get-Content -LiteralPath (Join-Path $repo 'codex_bridge\scripts\daily-runtime-settings.ps1') -Raw -Encoding UTF8
Check ($settings -match 'SecretPath=\$s.secretPath;Token=\$null') 'ambient token cannot silently authorize startup'
Check ($settings -match 'DAILY_LEGACY_DEPENDENCY_REJECTED') 'new settings reject Program Files legacy dependencies'
$ui=Get-Content -LiteralPath (Join-Path $repo 'codex_bridge\scripts\control-center-ui.ps1') -Raw -Encoding UTF8
Check ($ui -match '\$runtimeDir=\$dailyContext.runtimeDir;\$dataDir=\$dailyContext.dataDir') 'daily tray folders use existing private state'

$handoff=Join-Path $repo 'codex_bridge\scripts\cutover-daily-code.ps1'
. (Read-Function $handoff 'Stop-CutoverLegacy')
& {
    $legacy='C:\fixture\old';$script:roles=@();$script:actions=@();$script:fail=$false
    function Get-CutoverHealth {throw 'LEGACY_HEALTH_MUST_NOT_BE_CALLED'}
    function Get-CutoverOwnedRoles {param($OwnerRoot,$OperatorSid) return $script:roles}
    function Write-CutoverRecord {param($Name,$Value) $script:actions+=('record:'+ $Name)}
    function Invoke-CutoverScript {param($Entry,$Arguments)
        Check ($Entry -eq 'C:\fixture\old\codex_bridge\scripts\runtime-control.ps1') 'only exact old controller'
        $script:actions+=$Arguments
        if($script:fail){throw 'BLOCKED_GRACEFUL_SHUTDOWN_UNAVAILABLE'}
    }
    function Invoke-CutoverOwner {param($Action) $script:actions+=('new:'+ $Action)}
    Stop-CutoverLegacy @() 'fixture-owner' 'fixture-sid'
    Check (($script:actions -join ',') -ceq 'record:already-stopped.json,new:Stopped') 'stopped runtime skips all old controller and health calls'
    $script:roles=@([pscustomobject]@{role='server';pid=12},[pscustomobject]@{role='tunnel';pid=34});$script:actions=@()
    Stop-CutoverLegacy $script:roles 'fixture-owner' 'fixture-sid'
    Check (($script:actions -join ',') -ceq 'record:stop-intent.json,-Action ShutdownRuntime,new:Stopped') 'live runtime gets one shutdown without old Status or Ready'
    $script:actions=@();$script:fail=$true
    Denied {Stop-CutoverLegacy $script:roles 'fixture-owner' 'fixture-sid'} '^BLOCKED_GRACEFUL_SHUTDOWN_UNAVAILABLE$'
    Check ($script:actions -notcontains 'new:Stopped') 'controller failure stops handoff'
    $script:actions=@()
    Denied {Stop-CutoverLegacy @() 'fixture-owner' 'fixture-sid'} '^CUTOVER_OWNER_CHANGED$'
    Check ($script:actions.Count -eq 0) 'changed ownership is refused before shutdown'
}
. (Read-Function $handoff 'Get-CutoverOwnedRoles')
& {
    $legacy='C:\fixture\old'
    function Get-NetTCPConnection {param($State,$ErrorAction) return @()}
    function Get-CimInstance {param($ClassName,$ErrorAction) return @()}
    Check (@(Get-CutoverOwnedRoles 'fixture-owner' 'fixture-sid').Count -eq 0) 'empty ports and absent old executables resolve to stopped'
}
. (Read-Function $handoff 'Get-CutoverHealth')
& {
    function Invoke-RestMethod {param($Uri,$TimeoutSec) throw (New-Object Net.WebException('fixture',[Net.WebExceptionStatus]::ConnectFailure))}
    Denied {Get-CutoverHealth} '^CUTOVER_BRIDGE_NOT_READY$'
}
. (Read-Function $handoff 'Assert-CutoverIdle')
Assert-CutoverIdle ([pscustomobject]@{active=0;awaitingApproval=0;controller='ready'});Check $true 'idle accepted'
Denied {Assert-CutoverIdle ([pscustomobject]@{active=1;awaitingApproval=0;controller='ready'})} '^ACTIVE_WORK_PRESENT$'
Denied {Assert-CutoverIdle ([pscustomobject]@{active=0;awaitingApproval=1;controller='ready'})} '^ACTIVE_WORK_PRESENT$'
Denied {Assert-CutoverIdle ([pscustomobject]@{active=0;awaitingApproval=0;controller='busy'})} '^ACTIVE_WORK_PRESENT$'
. (Read-Function $handoff 'Assert-CutoverIndependent')
Denied {Assert-CutoverIndependent $PID} '^CUTOVER_SELF_HOSTED_JOB$'
. (Read-Function $handoff 'Get-CutoverControllerDiagnostic')
$diagnostic=Get-CutoverControllerDiagnostic '{"ok":false,"action":"ShutdownRuntime","errorCode":"COOPERATIVE_SHUTDOWN_UNKNOWN","message":"fixture-private-value"}' 'fixture-private-value' 1
Check ($diagnostic.code -ceq 'COOPERATIVE_SHUTDOWN_UNKNOWN' -and $diagnostic.action -ceq 'ShutdownRuntime' -and $diagnostic.ok -eq $false) 'structured controller failure retained despite stderr'
Check (($diagnostic|ConvertTo-Json -Compress) -notmatch 'fixture-private-value|message') 'raw payload is never retained'
$diagnostic=Get-CutoverControllerDiagnostic '' 'FullyQualifiedErrorId : NoProcessFoundForGivenId,Microsoft.PowerShell.Commands.GetProcessCommand' 1
Check ($diagnostic.engineErrorId -ceq 'NoProcessFoundForGivenId' -and $null -eq $diagnostic.code) 'bounded engine category retained'
$diagnostic=Get-CutoverControllerDiagnostic '{"ok":true,"action":"Status"}' '' 0
Check ($diagnostic.ok -eq $true -and $diagnostic.exitCode -eq 0 -and $diagnostic.stderrCharacters -eq 0) 'successful controller diagnostics'
$diagnostic=Get-CutoverControllerDiagnostic 'malformed fixture-private-value' 'unrecognized fixture-private-value' 1
Check (($diagnostic|ConvertTo-Json -Compress) -notmatch 'fixture-private-value' -and $null -eq $diagnostic.code) 'unrecognized output stays redacted'
$text=Get-Content -LiteralPath $handoff -Raw -Encoding UTF8
Check ($text -match 'Get-McpCcComponent -Manifest \$manifest -Id codex_bridge') 'handoff checks CC with the actual Id contract'
Check ($text -match 'Set-McpCcDeploymentSelection \$ccSource \$ControlCenterVersion') 'handoff selects independent CC through its existing API'
Check ($text -match 'start-runtime-tray.vbs" --boot') 'only Startup points at explicit CC boot entry'
Check ($text -notmatch 'Invoke-CutoverOwner (StartTray|ExitTray)|start-daily-code.vbs') 'handoff no longer delegates CC startup to Bridge'
Check ($text -notmatch 'Stop-Process|taskkill|RunAs|schtasks|installed-release-operator') 'handoff has no kill, elevation or legacy installer fallback'
Check ($text.Contains("') '-Action ShutdownRuntime'")) 'original owner performs shutdown'
Check ($text -notmatch "-Action Status|Wait-CutoverHealth|Assert-CutoverIdle \(Get-CutoverHealth\)") 'old readiness and health wait are absent'
Check ($text.IndexOf("`$phase='RETIRING_STARTUP'") -lt $text.IndexOf("`$phase='STARTING_NEW'")) 'old Startup is retired before new runtime starts'
Check ($text.IndexOf('$trayExitSignal=Test-CutoverTrayExitSignal') -lt $text.IndexOf("`$phase='STOPPING_LEGACY'")) 'exact event preflight precedes shutdown'
Check ($text.IndexOf('CUTOVER_MANUAL_TRAY_NOT_READY') -lt $text.IndexOf("`$phase='STOPPING_LEGACY'")) 'manual UI readiness is confirmed while Bridge still runs'
Check ($text.IndexOf('else {Wait-CutoverManualTrayExit $trayId}') -gt $text.IndexOf("`$phase='RETIRING_TRAY'")) 'old Tray remains alive through installed shutdown'
Check ($text -match 'WaitForExit\(120000\)' -and $text -match 'CUTOVER_MANUAL_TRAY_EXIT_NOT_COMPLETED') 'manual UI wait is bounded and fail closed'
$vbs=Get-Content -LiteralPath (Join-Path $repo 'mcp_control_center\scripts\start-runtime-tray.vbs') -Raw -Encoding UTF8
Check ($vbs -match '--boot' -and $vbs -match 'shell.Run\(command, 0, True\)') 'single hidden CC launcher has explicit boot mode'
$startFunction=Read-Function $handoff 'Start-CutoverControlCenter'
Check ($startFunction.ToString() -notmatch 'AutoReconcile|--boot|ReplaceExisting') 'one-time normal launch never reconciles other MCPs'
# Exercise the actual CC process guard with synthetic observations. No production
# singleton, process lookup, SID query or controller runs in this scope.
& {
    $tokens=$null;$errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile($handoff,[ref]$tokens,[ref]$errors)
    $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Assert-CutoverCcOwner'},$true)
    $patternNode=$fn.Find({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$pattern'},$true)
    $guardNode=$fn.Find({param($n) $n -is [Management.Automation.Language.IfStatementAst] -and $n.Clauses[0].Item1.Extent.Text.Contains('$info.ExecutablePath')},$true)
    $guard=[scriptblock]::Create($guardNode.Extent.Text)
    $ps='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
    $entry='C:\fixture\mcp_control_center\Runtime\versions\cc-v1\scripts\tray.ps1'
    $OperatorSid='fixture-user';$sid=[pscustomobject]@{ReturnValue=0;Sid=$OperatorSid}
    function Get-Process {param($Id) [pscustomobject]@{SessionId=55}}
    . ([scriptblock]::Create($patternNode.Extent.Text))
    $command='"'+$ps+'" -NoProfile -WindowStyle Hidden -File "'+$entry+'"'
    $info=[pscustomobject]@{ExecutablePath=$ps;CommandLine=$command;SessionId=55}
    & $guard;Check $true 'exact independent CC owner accepted'
    foreach($bad in @(($command+' -AutoReconcile'),($command+' -ReplaceExisting'),$command.Replace('cc-v1','cc-v2'),$command.Replace('-WindowStyle Hidden','-WindowStyle Normal'))){
        $info.CommandLine=$bad;Denied {& $guard} '^CUTOVER_CC_OWNER_UNKNOWN$'
    }
    $info.CommandLine=$command;$info.ExecutablePath='C:\foreign\powershell.exe'
    Denied {& $guard} '^CUTOVER_CC_OWNER_UNKNOWN$'
    $info.ExecutablePath=$ps;$sid.Sid='foreign-user'
    Denied {& $guard} '^CUTOVER_CC_OWNER_UNKNOWN$'
    $sid.Sid=$OperatorSid;$sid.ReturnValue=5
    Denied {& $guard} '^CUTOVER_CC_OWNER_UNKNOWN$'
    $sid.ReturnValue=0;$info.SessionId=56
    Denied {& $guard} '^CUTOVER_CC_OWNER_UNKNOWN$'
}
foreach($file in @('daily-code-owner.ps1','daily-runtime-settings.ps1','daily-bearer.ps1','cutover-daily-code.ps1','runtime-control.ps1')) {
    $tokens=$null;$errors=$null
    [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $repo ('codex_bridge\scripts\'+$file)),[ref]$tokens,[ref]$errors)
    Check (@($errors).Count -eq 0) ('parse '+$file)
}
# Execute the actual terminal catch in child processes, with real CreateNew receipts.
# No lifecycle function, fixed live path or secret provider runs in these fixtures.
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($handoff,[ref]$tokens,[ref]$errors)
$outer=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})[-1]
$catchBody=$outer.CatchClauses[0].Body.Extent.Text
$writer=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Write-CutoverRecord'},$true).Extent.Text
$initialization=@($text -split '\r?\n'|Where-Object {$_ -like '$phase=*'})[0]
$sandbox=Join-Path ([IO.Path]::GetTempPath()) ('daily-cutover-fixture-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($sandbox)
try {
    . (Read-Function $handoff 'Retire-CutoverStartup')
    $module=Import-Module (Join-Path $repo 'mcp_control_center/src/McpControlCenter.DailyCode.psm1') -PassThru -Force
    $shortcut=Join-Path $sandbox 'startup.lnk';$backup=Join-Path $sandbox 'backup.lnk';$retired=Join-Path $sandbox 'retired.lnk'
    [IO.File]::WriteAllText($shortcut,'fixture original');[IO.File]::WriteAllText($backup,'fixture changed')
    Denied {Retire-CutoverStartup $shortcut $backup $retired} '^CUTOVER_STARTUP_CHANGED$'
    Check (Test-Path -LiteralPath $shortcut) 'changed startup remains untouched'
    [IO.File]::WriteAllText($backup,'fixture original')
    Retire-CutoverStartup $shortcut $backup $retired
    Check (-not(Test-Path -LiteralPath $shortcut) -and (Test-Path -LiteralPath $retired)) 'old entry moved out of Startup'
    Check ((Get-FileHash -LiteralPath $backup).Hash -ceq (Get-FileHash -LiteralPath $retired).Hash) 'retired startup bytes preserved'
    $fixtureScript=Join-Path $sandbox 'terminal.ps1'
    $prefix=@'
param($ModulePath,$OutputPath,$ScenarioPhase,$FailureCode)
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$module=Import-Module $ModulePath -PassThru -Force
'@
    $body=$prefix+"`n"+$initialization+"`n"+$writer+"`n"+'$op=$OutputPath;$phase=$ScenarioPhase'+"`n"+'try {throw $FailureCode} catch '+$catchBody
    [IO.File]::WriteAllText($fixtureScript,$body,(New-Object Text.UTF8Encoding($true)))
    foreach($case in @(
        @{phase='PREFLIGHT';code='DAILY_BEARER_UNAVAILABLE';terminal='REJECTED'},
        @{phase='RETIRING_TRAY';code='CUTOVER_MANUAL_TRAY_EXIT_NOT_COMPLETED';terminal='UNKNOWN'},
        @{phase='STOPPING_LEGACY';code='COOPERATIVE_SHUTDOWN_UNKNOWN';terminal='UNKNOWN'})) {
        $dir=Join-Path $sandbox $case.phase;[void][IO.Directory]::CreateDirectory($dir)
        $result=& 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -File $fixtureScript -ModulePath (Join-Path $repo 'mcp_control_center\src\McpControlCenter.DailyCode.psm1') -OutputPath $dir -ScenarioPhase $case.phase -FailureCode $case.code
        Check ($LASTEXITCODE -eq 1) ($case.phase+' exits nonzero')
        $reported=($result -join "`n")|ConvertFrom-Json
        $failure=Get-Content -LiteralPath (Join-Path $dir 'failure.json') -Raw|ConvertFrom-Json
        $terminal=Get-Content -LiteralPath (Join-Path $dir 'terminal.json') -Raw|ConvertFrom-Json
        Check ($reported.code -ceq $case.code -and $failure.code -ceq $case.code) ($case.phase+' original error retained')
        Check ($terminal.phase -ceq $case.terminal -and $terminal.code -ceq $case.code -and $terminal.automaticRetry -eq $false) ($case.phase+' terminal persisted')
    }
}finally{
    $resolved=[IO.Path]::GetFullPath($sandbox)
    if((Split-Path -Parent $resolved) -ine [IO.Path]::GetTempPath().TrimEnd('\') -or (Split-Path -Leaf $resolved) -cnotmatch '^daily-cutover-fixture-[0-9a-f]{32}$'){throw 'FIXTURE_CLEANUP_REJECTED'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
@{ok=$true;passed=$passed;live=$false;credentialsRead=$false;servicesChanged=$false}|ConvertTo-Json
