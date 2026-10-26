Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Import-Module (Join-Path $source 'src\McpControlCenter.Deployment.psm1') -Force
$fixture = Join-Path $env:TEMP ('mcpcc-launch-'+[guid]::NewGuid().ToString('N'))
$manager = Join-Path $fixture 'mcp_control_center\Runtime\versions\probe'
$script:checks=0
function Check([bool]$Value,[string]$Message) {
    if (-not $Value) {throw ('CHECK_FAILED: '+$Message)}; $script:checks++
}
[void][IO.Directory]::CreateDirectory((Join-Path $manager 'scripts'))
$tray = Join-Path $manager 'scripts\tray.ps1'
# Inert script only: query this child's OS identity, then exit. No tray, mutex,
# controller, component, state root or production named pipe is opened.
$probe = @'
param([switch]$AutoReconcile)
$ErrorActionPreference='Stop'
$process=Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
@{pid=$PID;commandLine=$process.CommandLine;script=$PSCommandPath;autoReconcile=[bool]$AutoReconcile;scriptHash=(Get-FileHash -LiteralPath $PSCommandPath).Hash} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'identity.json') -Encoding UTF8
'@
[IO.File]::WriteAllText($tray,$probe)
$savedModules=$env:PSModulePath
try {
    $env:PSModulePath=Join-Path $fixture 'foreign-powershell-modules'
    $info = New-McpCcDeploymentTrayStartInfo ([pscustomobject]@{managerRoot=$manager})
} finally {$env:PSModulePath=$savedModules}
Check ($info.Arguments -ceq ('-NoProfile -WindowStyle Hidden -File "'+$tray+'"')) 'actual version is OS -File argument'
Check ($info.CreateNoWindow -and -not $info.UseShellExecute) 'hidden creation without shell'
Check ($info.Arguments -notmatch '-AutoReconcile|-ReplaceExisting') 'no reconcile or replacement'
$child = New-Object Diagnostics.Process
$child.StartInfo=$info
try {
    Check ($child.Start()) 'inert version child starts'
    if (-not $child.WaitForExit(15000)) { throw 'FIXTURE_CHILD_TIMEOUT_NO_KILL' }
    Check ($child.ExitCode -eq 0) 'identity probe exits normally'
    $identity=Get-Content -LiteralPath (Join-Path $manager 'scripts\identity.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Check ($identity.pid -eq $child.Id -and $identity.pid -ne $PID) 'separate PowerShell child'
    Check ($identity.script -ceq $tray -and $identity.commandLine.Contains('-File "'+$tray+'"')) 'OS command line and loaded script agree'
    Check (-not $identity.autoReconcile) 'daily child does not reconcile'
    Check ($identity.scriptHash -ceq (Get-FileHash -LiteralPath $tray).Hash) 'child loads Windows PowerShell built-ins despite inherited foreign module path'
} finally { $child.Dispose() }
$bootInfo=New-McpCcDeploymentTrayStartInfo ([pscustomobject]@{managerRoot=$manager}) -Boot
Check ($bootInfo.Arguments -ceq ($info.Arguments+' -AutoReconcile')) 'only explicit boot enables reconciliation'
$child=New-Object Diagnostics.Process
$child.StartInfo=$bootInfo
try {
    Check ($child.Start()) 'inert boot child starts'
    if(-not $child.WaitForExit(15000)){throw 'FIXTURE_BOOT_TIMEOUT_NO_KILL'}
    Check ($child.ExitCode -eq 0) 'inert boot child completes'
    $identity=Get-Content -LiteralPath (Join-Path $manager 'scripts\identity.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Check ($identity.autoReconcile -and $identity.commandLine.Contains('-File "'+$tray+'" -AutoReconcile')) 'boot flag reaches actual version child'
} finally {$child.Dispose()}
$vbs=[IO.File]::ReadAllText((Join-Path $source 'scripts\start-runtime-tray.vbs'))
Check ($vbs.Contains('WScript.Arguments(0) <> "--boot"') -and $vbs.Contains('If boot Then command = command & " -Boot"')) 'one VBS entry validates and forwards explicit boot flag'
$launcher=[IO.File]::ReadAllText((Join-Path $source 'scripts\start-runtime-tray.ps1'))
Check ($launcher.Contains('param([switch]$Boot)') -and $launcher.Contains('-Boot:$Boot')) 'stable PowerShell entry forwards boot without default enablement'

# Run the actual ordinary Exit state machine, replacing UI/controller surfaces
# with in-memory fakes. Only the signal for this fixture PID/start time is real.
Add-Type -AssemblyName System.Windows.Forms
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $source 'scripts\tray.ps1'),[ref]$tokens,[ref]$errors)
Check ($errors.Count -eq 0) 'tray parses'
foreach($name in @('New-TrayExitSignal','Request-TrayExit','Complete-TrayExit','Get-TrayControllerState','Test-TrayMaintenanceBusy')) {
    $node=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true)
    . ([scriptblock]::Create($node.Extent.Text))
}
function Update-TrayControllerLifecycle { Complete-TrayExit }
function Stop-TrayApplication { $script:exitCalls++ }
function Set-TrayRestartFeedback {param($Message,[switch]$Warning) $script:feedback++}
function Show-Warning {param($Message) throw 'MODAL_NOT_EXPECTED'}
$projectRoot=$manager
$manifest=[pscustomobject]@{schemaVersion=3;codeDeployment=@{managerRoot=$manager}}
$signal=New-TrayExitSignal
try {
    Check ($null -ne $signal) 'CC deployment accepts existing cooperative Exit event'
    $self=Get-Process -Id $PID
    try {$eventName='Local\McpCc.InstalledTrayExit.v1.'+$PID+'.'+$self.StartTime.ToUniversalTime().Ticks} finally {$self.Dispose()}
    $client=[Threading.EventWaitHandle]::OpenExisting($eventName)
    try {$null=$client.Set();Check ($signal.WaitOne(0)) 'same existing event protocol'} finally {$client.Dispose()}
    foreach($mode in @('idle','busy','unknown','workspace')) {
        $script:Closing=$false;$script:ExitRequested=$false;$script:ExitClock=$null
        $script:ControllerProcess=$null;$script:PendingAction=$null;$script:PendingLabel=$null
        $script:PendingRestartMcp=$null
        $script:timer=[pscustomobject]@{}
        $script:timer | Add-Member ScriptMethod Stop {}
        $script:notifyIcon=[pscustomobject]@{Visible=$true}
        $script:WorkspaceLocalWorker=$null;$script:WorkspaceLocalOwner=$null
        $script:SelfReloadWorker=$null;$script:SelfReloadShutdown=$null;$script:NormalOperatorWorker=$null
        $script:exitCalls=0;$script:feedback=0
        if($mode -eq 'busy'){$script:ControllerProcess=[pscustomobject]@{HasExited=$false};$script:PendingAction='RestartMcp'}
        if($mode -eq 'unknown'){$script:ControllerProcess=[pscustomobject]@{HasExited=$null}}
        if($mode -eq 'workspace'){$script:WorkspaceLocalWorker=@{pending=@{IsCompleted=$false}}}
        Request-TrayExit -NonInteractive
        if($mode -eq 'idle'){Check ($script:exitCalls -eq 1) 'idle uses normal application Exit'}
        else{Check (-not $script:ExitRequested -and $script:exitCalls -eq 0) ($mode+' refuses Exit without stopping anything')}
    }
} finally {$signal.Dispose()}
[pscustomobject]@{ok=$true;checks=$script:checks;fixture=$fixture;productionTray=$false;liveActions=0} | ConvertTo-Json
