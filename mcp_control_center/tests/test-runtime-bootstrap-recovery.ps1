Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$source=Split-Path -Parent $PSScriptRoot
$workspace=Split-Path -Parent $source
. (Join-Path $workspace 'project_reading/scripts/component-update-common.ps1')
if(-not('McpCc.WorkspaceLocal.UpdateStore' -as [type])){Add-Type -Path (Join-Path $source 'src/WorkspaceLocal.Native.cs') -ReferencedAssemblies System.Web.Extensions,System.Core}
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('ccb-'+[guid]::NewGuid().ToString('N').Substring(0,16))
$script:checks=0;$script:cases=@()
function Assert-Bootstrap($Condition,[string]$Label){if(-not $Condition){throw ('FAIL: '+$Label)};$script:checks++}
function Write-FixtureText([string]$Path,[string]$Text){[void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path));[IO.File]::WriteAllText($Path,$Text,(New-Object Text.UTF8Encoding($false)))}
function New-BootstrapCase([string]$Name,[string]$Selected){
    $case=Join-Path $testRoot $Name;$manager=Join-Path $case 'mcp_control_center'
    $script:cases+=,$manager
    $entry=Join-Path $manager 'scripts/runtime-bootstrap.ps1'
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $entry))
    Copy-Item -LiteralPath (Join-Path $source 'scripts/runtime-bootstrap.ps1') -Destination $entry
    Assert-Bootstrap ((Get-FileHash -LiteralPath $entry).Hash -eq (Get-FileHash -LiteralPath (Join-Path $source 'scripts/runtime-bootstrap.ps1')).Hash) 'fixture executes exact bootstrap bytes'
    $native=Get-Content -LiteralPath (Join-Path $source 'src/WorkspaceLocal.Native.cs') -Raw -Encoding UTF8
    $needle='public const string PipeName = "mcpcc-workspace-local-v1";'
    Assert-Bootstrap ($native.Split(@($needle),[StringSplitOptions]::None).Count -eq 2) 'only the test IPC namespace is replaced'
    # Keep the real framed native IPC/peer verification and durable UpdateStore.
    # Only its pipe name is unique, so no production pipe can be opened.
    $native=$native.Replace($needle,('public const string PipeName = "mcpcc-bootstrap-fixture-'+[guid]::NewGuid().ToString('N')+'";'))
    Write-FixtureText (Join-Path $manager 'src/WorkspaceLocal.Native.cs') $native
    Write-FixtureText (Join-Path $case 'project_reading/scripts/component-update-common.ps1') (Get-Content -LiteralPath (Join-Path $workspace 'project_reading/scripts/component-update-common.ps1') -Raw -Encoding UTF8)
    # Deployment is a fixture-owned boundary: no real selector, component or
    # singleton is touched. The updater being exercised remains byte-identical.
    Write-FixtureText (Join-Path $manager 'src/McpControlCenter.Deployment.psm1') @'
function Get-McpCcDeploymentLayout([string]$ManagerRoot){return $null}
function Test-McpCcDeploymentVersion([string]$Root,[string]$Version){
    $candidate=Join-Path $Root ('versions/'+$Version)
    if(-not(Test-Path -LiteralPath (Join-Path $candidate 'code-inventory.json'))){throw 'CC_FIXTURE_CANDIDATE_MISSING'}
    [pscustomobject]@{managerRoot=$candidate;workspaceRoot=(Split-Path -Parent (Split-Path -Parent $Root))}
}
function Set-McpCcDeploymentSelection([string]$SourceRoot,[string]$Version){
    [IO.File]::AppendAllText((Join-Path $SourceRoot 'actions.txt'),"select`n")
    [IO.File]::WriteAllText((Join-Path $SourceRoot 'Runtime/current.json'),('{"contract":"mcpcc-current-v1","version":"'+$Version+'"}'))
}
Export-ModuleMember -Function Get-McpCcDeploymentLayout,Test-McpCcDeploymentVersion,Set-McpCcDeploymentSelection
'@
    $tray=@'
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$source=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))
Add-Type -Path (Join-Path $source 'src/WorkspaceLocal.Native.cs') -ReferencedAssemblies System.Web.Extensions,System.Core
$owner=[McpCc.WorkspaceLocal.Owner]::Open((Join-Path $source '.local/runtime'))
$process=[Diagnostics.Process]::GetCurrentProcess();$ticks=$process.StartTime.ToUniversalTime().Ticks
$event=New-Object Threading.EventWaitHandle($false,[Threading.EventResetMode]::AutoReset,('Local\McpCc.InstalledTrayExit.v1.'+$PID+'.'+$ticks))
try{
    $rows=@(foreach($id in [McpCc.WorkspaceLocal.Contract]::Ids){$row=[McpCc.WorkspaceLocal.Row]::new();$row.componentId=$id;$row.status='UNVERIFIED';$row.observedAt=[DateTimeOffset]::UtcNow.ToString('o');$row.capabilities=@();$row})
    $owner.Publish([McpCc.WorkspaceLocal.Snapshot]::new([McpCc.WorkspaceLocal.Row[]]$rows));$owner.Start()
    [IO.File]::WriteAllText((Join-Path $source 'tray-instance.json'),(@{pid=$PID;startTicks=[string]$ticks}|ConvertTo-Json))
    [void]$event.WaitOne(90000)
}finally{$event.Dispose();$owner.Dispose();$process.Dispose()}
'@
    foreach($version in @('old','target','later')){
        Write-FixtureText (Join-Path $manager ('Runtime/versions/'+$version+'/scripts/tray.ps1')) $tray
        Write-FixtureText (Join-Path $manager ('Runtime/versions/'+$version+'/code-inventory.json')) ('{"fixture":"'+$version+'"}')
    }
    Write-FixtureText (Join-Path $manager 'Runtime/current.json') ('{"contract":"mcpcc-current-v1","version":"'+$Selected+'"}')
    Write-FixtureText (Join-Path $manager 'scripts/start-runtime-tray.vbs') "' Fixture launcher boundary; never executed.`n"
    Write-FixtureText (Join-Path $case 'invoke.ps1') @'
param([string]$Manager,[string]$RequestId,[string]$Mode)
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $Manager 'src/WorkspaceLocal.Native.cs') -ReferencedAssemblies System.Web.Extensions,System.Core
function Start-Process {
    param([string]$FilePath,[string]$ArgumentList,[string]$WindowStyle,[switch]$PassThru)
    if($FilePath -ine (Join-Path $env:WINDIR 'System32/wscript.exe') -or $ArgumentList -cne ('"'+(Join-Path $Manager 'scripts/start-runtime-tray.vbs')+'"') -or $WindowStyle -cne 'Hidden' -or -not $PassThru){throw 'CC_FIXTURE_LAUNCH_CONTRACT'}
    [IO.File]::AppendAllText((Join-Path $Manager 'actions.txt'),"start`n")
    if($Mode -eq 'interrupt-start'){throw 'CC_FIXTURE_START_INTERRUPTED'}
    $selected=(Get-Content -LiteralPath (Join-Path $Manager 'Runtime/current.json') -Raw|ConvertFrom-Json).version
    if($Mode -eq 'fail-new' -and $selected -eq 'target'){throw 'CC_FIXTURE_NEW_START_FAILED'}
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=Join-Path $PSHOME 'powershell.exe';$info.Arguments='-NoProfile -NonInteractive -File "'+(Join-Path $Manager ('Runtime/versions/'+$selected+'/scripts/tray.ps1'))+'"'
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    [Diagnostics.Process]::Start($info)
}
$global:LASTEXITCODE=0
$reply=& (Join-Path $Manager 'scripts/runtime-bootstrap.ps1') -RequestId $RequestId -VersionId target
[IO.File]::WriteAllText((Join-Path $Manager 'bootstrap-result.json'),($reply -join "`n"))
if($LASTEXITCODE -ne 0 -and $Error.Count){[IO.File]::WriteAllText((Join-Path $Manager 'fixture-error.txt'),($Error[0].ToString()+"`n"+$Error[0].ScriptStackTrace))}
exit $LASTEXITCODE
'@
    $id=[guid]::NewGuid().ToString('D');$state=Join-Path $manager '.local/runtime'
    $store=[McpCc.WorkspaceLocal.UpdateStore]::new($state)
    $request=New-Object 'Collections.Generic.Dictionary[string,string]'
    foreach($pair in @{requestId=$id;componentId='mcp_control_center';versionId='target';expectedSourceDigest=('a'*64)}.GetEnumerator()){$request.Add($pair.Key,$pair.Value)}
    $null=$store.Reserve($request)
    $pin=(Get-FileHash -LiteralPath (Join-Path $manager 'Runtime/versions/target/code-inventory.json')).Hash.ToLowerInvariant()
    $store.Complete($id,'RUNNING','CC_BOOTSTRAP_PENDING',$null,$null,$null,$null,$pin)
    if($Name -in @('start','later')){Write-ComponentUpdateJson (Join-Path $state ('workspace-update-requests/bootstrap/'+$id+'/transition-intent.json')) @{requestId=$id;from='old';to='target';preparedBuildId=$pin}}
    [pscustomobject]@{root=$case;manager=$manager;requestId=$id;store=$store;pin=$pin}
}
function Invoke-BootstrapCase($Case,[string]$Mode){
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=Join-Path $PSHOME 'powershell.exe'
    $info.Arguments='-NoProfile -NonInteractive -File "'+(Join-Path $Case.root 'invoke.ps1')+'" -Manager "'+$Case.manager+'" -RequestId '+$Case.requestId+' -Mode '+$Mode
    # The fixture tray is intentionally long-lived. A Windows child can retain
    # inherited capture handles even with redirected standard streams, so the
    # bootstrap publishes its bounded result file and this harness waits only
    # for the exact bootstrap process to exit.
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true
    $process=New-Object Diagnostics.Process;$process.StartInfo=$info
    try{
        [void]$process.Start()
        if(-not $process.WaitForExit(75000)){throw 'FIXTURE_BOOTSTRAP_DID_NOT_EXIT'}
        $text=[IO.File]::ReadAllText((Join-Path $Case.manager 'bootstrap-result.json'))
        $diagnostic=Join-Path $Case.manager 'fixture-error.txt'
        [pscustomobject]@{exitCode=$process.ExitCode;receipt=($text|ConvertFrom-Json);diagnostic=$(if(Test-Path -LiteralPath $diagnostic){[IO.File]::ReadAllText($diagnostic)}else{$null})}
    }finally{$process.Dispose()}
}
function Stop-FixtureTray([string]$Manager){
    $instancePath=Join-Path $Manager 'tray-instance.json'
    if(-not(Test-Path -LiteralPath $instancePath)){return}
    $instance=Read-ComponentUpdateJson $instancePath
    try{$process=[Diagnostics.Process]::GetProcessById([int]$instance.pid)}catch [ArgumentException]{return}
    try{
        if($process.StartTime.ToUniversalTime().Ticks -ne [long]$instance.startTicks){return}
        $event=[Threading.EventWaitHandle]::OpenExisting('Local\McpCc.InstalledTrayExit.v1.'+$instance.pid+'.'+$instance.startTicks)
        try{[void]$event.Set()}finally{$event.Dispose()}
        if(-not $process.WaitForExit(10000)){throw 'FIXTURE_TRAY_DID_NOT_COOPERATIVELY_EXIT'}
    }finally{$process.Dispose()}
}
try{
    $case=New-BootstrapCase 'start' old
    $first=Invoke-BootstrapCase $case interrupt-start
    Assert-Bootstrap ($first.exitCode -eq 1 -and $first.receipt.phase -eq 'RECOVERY_REQUIRED' -and $first.receipt.code -eq 'CC_ROLLBACK_EVIDENCE_MISSING') ('selection followed by start failure remains recoverable: '+($first|ConvertTo-Json -Compress -Depth 5))
    Assert-Bootstrap ((Read-ComponentUpdateJson (Join-Path $case.manager 'Runtime/current.json')).version -eq 'target') 'start failure occurs after selection'
    Assert-Bootstrap (Test-Path -LiteralPath (Join-Path $case.manager ('.local/runtime/workspace-update-requests/bootstrap/'+$case.requestId+'/transition-intent.json'))) 'original transition intent is durable'
    $second=Invoke-BootstrapCase $case start
    Assert-Bootstrap ($second.exitCode -eq 0 -and $second.receipt.phase -eq 'ACCEPTED' -and $second.receipt.code -eq 'CC_OWNER_AND_IPC_VERIFIED' -and $second.receipt.preparedBuildId -eq $case.pin) ('same request starts selected owner and verifies real isolated native IPC: '+($second|ConvertTo-Json -Compress -Depth 5))
    $actions=Get-Content -LiteralPath (Join-Path $case.manager 'actions.txt')
    Assert-Bootstrap (@($actions|Where-Object {$_ -eq 'select'}).Count -eq 1 -and @($actions|Where-Object {$_ -eq 'start'}).Count -eq 2) 'reentry does not select again'
    Stop-FixtureTray $case.manager

    $case=New-BootstrapCase 'rollback' old
    $result=Invoke-BootstrapCase $case fail-new
    Assert-Bootstrap ($result.exitCode -eq 0 -and $result.receipt.phase -eq 'REJECTED' -and $result.receipt.code -eq 'CC_ROLLED_BACK_OWNER_AND_IPC_VERIFIED' -and $result.receipt.ready -eq $true) ('failed new tray restores verified old owner and IPC: '+($result|ConvertTo-Json -Compress -Depth 5))
    Assert-Bootstrap ($result.receipt.requestId -eq $case.requestId -and $result.receipt.preparedBuildId -eq $case.pin -and $result.receipt.selectedVersion -eq 'old') 'rollback preserves original ID and candidate pin'
    $before=[IO.File]::ReadAllText((Join-Path $case.manager 'actions.txt'))
    $replay=Invoke-BootstrapCase $case start
    Assert-Bootstrap ($replay.receipt.code -eq $result.receipt.code -and [IO.File]::ReadAllText((Join-Path $case.manager 'actions.txt')) -ceq $before) 'rollback terminal replay does not select or start'
    Stop-FixtureTray $case.manager

    $case=New-BootstrapCase 'selected' target
    $result=Invoke-BootstrapCase $case start
    Assert-Bootstrap ($result.receipt.phase -eq 'ACCEPTED' -and $result.receipt.ready -eq $true) 'selected candidate with no tray reaches owner and IPC ready'
    Assert-Bootstrap ((Get-Content -LiteralPath (Join-Path $case.manager 'actions.txt') -Raw).Trim() -eq 'start') 'already-selected path only starts ordinary launcher'
    Stop-FixtureTray $case.manager

    $case=New-BootstrapCase 'later' old
    $first=Invoke-BootstrapCase $case interrupt-start
    Write-FixtureText (Join-Path $case.manager 'Runtime/current.json') '{"contract":"mcpcc-current-v1","version":"later"}'
    $before=[IO.File]::ReadAllText((Join-Path $case.manager 'actions.txt'))
    $result=Invoke-BootstrapCase $case start
    Assert-Bootstrap ($result.receipt.phase -eq 'REJECTED' -and $result.receipt.code -eq 'CC_BOOTSTRAP_SUPERSEDED') 'a later selected version terminalizes old recovery without downgrading'
    Assert-Bootstrap ([IO.File]::ReadAllText((Join-Path $case.manager 'actions.txt')) -ceq $before -and (Read-ComponentUpdateJson (Join-Path $case.manager 'Runtime/current.json')).version -eq 'later') 'superseded reentry performs no select or start'
    [pscustomobject]@{ok=$true;checks=$script:checks;bootstrap='EXACT_SOURCE_BYTES';ipc='REAL_NATIVE_UNIQUE_TEST_PIPE';deployment='ISOLATED_LAYOUT_OWNER_BOUNDARY';productionMutation=$false}|ConvertTo-Json
}finally{
    foreach($manager in $script:cases){Stop-FixtureTray $manager}
    $resolved=[IO.Path]::GetFullPath($testRoot)
    if(-not $resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolved) -cnotmatch '^ccb-[a-f0-9]{16}$'){throw 'FIXTURE_CLEANUP_PATH_REJECTED'}
    if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
