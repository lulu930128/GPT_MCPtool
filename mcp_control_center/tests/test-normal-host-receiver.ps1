[CmdletBinding()]
param([switch]$IdleAdmission)
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
if ($PSVersionTable.PSEdition -cne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5) { throw 'WINDOWS_POWERSHELL_51_REQUIRED' }
$root=Split-Path -Parent $PSScriptRoot
$sources=@('NormalOperator.Native.cs','NormalOperator.Pipe.cs','NormalOperator.Security.cs','NormalOperator.Execution.cs','NormalOperator.Host.cs') | ForEach-Object { Join-Path $root ('src\'+$_) }
$sources+=Join-Path $PSScriptRoot 'NormalHostReceiver.Check.cs'
$sources+=Join-Path $PSScriptRoot 'NormalPipeHandler.Check.cs'
Add-Type -Path $sources -ReferencedAssemblies System.Web.Extensions,System.Core,System.Security,System.Windows.Forms,System.Drawing
$checks=0
foreach($path in @((Join-Path $root 'src\McpControlCenter.NormalOperator.psm1'),(Join-Path $root 'scripts\tray.ps1'),
    (Join-Path $root 'src\McpControlCenter.InstalledRelease.psm1'),(Join-Path $root 'tests\test-normal-pipe-handler.ps1'),
    (Join-Path $root '..\codex_bridge\scripts\powershell-host-transport.ps1'))) {
    $tokens=$null;$errors=$null
    $null=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
    if($errors.Count){throw ('SOURCE_PARSE_FAILED '+$path)};$checks++
}
# Execute only the three source Exit functions with inert collaborators. No Tray
# startup, UI, installed manifest, runtime directory, service or process is opened.
$tokens=$null;$errors=$null
$trayAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'scripts\tray.ps1'),[ref]$tokens,[ref]$errors)
foreach($name in @('Test-TrayMaintenanceBusy','Request-TrayExit','Complete-TrayExit')) {
    $definition=$trayAst.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true)
    Invoke-Expression $definition.Extent.Text
}
function Show-Warning { throw 'PASSIVE_HOST_BLOCKED_EXIT' }
function Get-TrayControllerState { return 'Idle' }
function Update-TrayControllerLifecycle { }
function Stop-TrayApplication { $script:testExited=$true }
function Show-TrayControllerWarning { throw 'UNEXPECTED_DRAIN_TIMEOUT' }
$script:Closing=$false;$script:ExitRequested=$false;$script:WorkspaceLocalWorker=$null;$script:WorkspaceLocalOwner=$null
$script:SelfReloadWorker=$null;$script:SelfReloadShutdown=$null;$script:testExited=$false
$completion=New-Object 'Threading.Tasks.TaskCompletionSource[bool]'
$cancel=New-Object Threading.CancellationTokenSource
$script:NormalOperatorWorker=@{pending=$completion.Task;cancellation=$cancel}
$timer=New-Object PSObject;$timer | Add-Member ScriptMethod Stop { }
$notifyIcon=[pscustomobject]@{Visible=$true}
try {
    if(Test-TrayMaintenanceBusy){throw 'PASSIVE_HOST_MARKED_MAINTENANCE'};$checks++
    Request-TrayExit
    if(-not $script:ExitRequested -or -not $cancel.IsCancellationRequested){throw 'HOST_ADMISSION_NOT_CANCELLED'};$checks++
    Complete-TrayExit
    if($script:testExited){throw 'EXIT_BEFORE_HOST_DRAIN'}
    $completion.SetResult($true);Complete-TrayExit
    if(-not $script:testExited -or -not $script:Closing){throw 'DRAINED_HOST_PREVENTED_EXIT'};$checks++
} finally { $cancel.Dispose();$script:NormalOperatorWorker=$null }
try {
    $result=if($IdleAdmission){[NormalHostReceiverCheck]::RunIdleAdmission()}else{[NormalHostReceiverCheck]::Run()}
}
catch {
    $current=[Diagnostics.Process]::GetCurrentProcess()
    try {
        $token=[McpCcNormalSecurity]::Observe($current)
        [pscustomobject]@{ failure=$_.Exception.GetBaseException().Message; session=$token.session;
            integrity=$token.integrityRid;tokenType=$token.tokenType;elevationType=$token.elevationType;
            elevated=$token.elevated;restricted=$token.restricted;appContainer=$token.appContainer } | ConvertTo-Json -Compress | Write-Output
    } finally { $current.Dispose() }
    throw
}
[pscustomobject]@{result='PASS_AVAILABLE_CHECKS';astAndExitChecks=$checks;nativeChecks=$result;nativePipe=[NormalHostReceiverCheck]::TransportStatus;
    idleAdmission=[NormalHostReceiverCheck]::IdleAdmissionStatus;
    idleAdmissionDelayMs=$(if($IdleAdmission){[NormalHostReceiverCheck]::IdleAdmissionDelayMilliseconds}else{0});
    authority='NOT_VERIFIED';hostCeremony='BLOCKED_PLATFORM_CAPABILITY';dispatch='NOT_RUN';installedRelease='NOT_TESTED';liveMutation=$false} | ConvertTo-Json -Compress
