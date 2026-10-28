Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$core=Import-Module (Join-Path $repo 'mcp_control_center/src/McpControlCenter.Core.psm1') -Force -PassThru
$daily=Import-Module (Join-Path $repo 'mcp_control_center/src/McpControlCenter.DailyCode.psm1') -Force -PassThru
$bridge=Import-Module (Join-Path $repo 'codex_bridge/scripts/codex-bridge-runtime.psm1') -Force -PassThru
$root=Join-Path ([IO.Path]::GetTempPath()) ('cc-daily-lock-'+[guid]::NewGuid().ToString('N'))
$passed=0;$holder=$null;$tx=$null
function Check([bool]$v,[string]$n){if(-not $v){throw "FAILED: $n"};$script:passed++}
function Put($p,$v){[void][IO.Directory]::CreateDirectory((Split-Path -Parent $p));[IO.File]::WriteAllText($p,$v)}
function Launch($p){$i=New-Object Diagnostics.ProcessStartInfo;$i.FileName=Join-Path $PSHOME 'powershell.exe';$i.Arguments='-NoProfile -File "'+$p+'"';$i.UseShellExecute=$false;$i.CreateNoWindow=$true;return [Diagnostics.Process]::Start($i)}
try {
    Put (Join-Path $root 'holder.ps1') @'
$m=New-Object Threading.Mutex($false,'Local\McpControlCenter.Action.codex_bridge')
if(-not $m.WaitOne(0)){exit 2}
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'held'),'held')
while(-not(Test-Path (Join-Path $PSScriptRoot 'release'))){Start-Sleep -Milliseconds 20}
$m.ReleaseMutex();$m.Dispose()
'@
    Put (Join-Path $root 'probe.ps1') @'
$m=New-Object Threading.Mutex($false,'Local\McpControlCenter.Action.codex_bridge')
$held=$m.WaitOne(0)
if($held){$m.ReleaseMutex();$m.Dispose();exit 3}
$m.Dispose();exit 0
'@
    Put (Join-Path $root 'controller.ps1') '# inert controller fixture'
    Put (Join-Path $root 'selector') 'B'
    & $core {param($r)
        $script:FixtureRoot=$r;$script:Reads=0;$script:Selected=$null;$script:RequireMutex=$true
        # Keep actual Get-McpCcComponent refresh; replace only manifest disk schema
        # and controller invocation with a bounded inert fixture.
        function script:Read-McpCcManifest {param($Path)
            $script:Reads++
            if($script:RequireMutex){
                $i=New-Object Diagnostics.ProcessStartInfo;$i.FileName=Join-Path $PSHOME 'powershell.exe'
                $i.Arguments='-NoProfile -File "'+(Join-Path $script:FixtureRoot 'probe.ps1')+'"';$i.UseShellExecute=$false;$i.CreateNoWindow=$true
                $p=[Diagnostics.Process]::Start($i)
                try {if(-not $p.WaitForExit(10000) -or $p.ExitCode -ne 0){throw 'SELECTOR_RESOLVED_OUTSIDE_MUTEX'}}finally{$p.Dispose()}
            }
            $script:Selected=[IO.File]::ReadAllText((Join-Path $script:FixtureRoot 'selector'))
            return [pscustomobject]@{components=@([pscustomobject]@{id='codex_bridge';resolvedRoot=$script:FixtureRoot})}
        }
        function script:Get-McpCcComponentActionBinding {param($Component,$Action) return @{semanticAction=$Action;manifestAction=$Action;runtimeMode='fixture';standardArguments=@();actionSpec=@{kind='powershell';path='controller.ps1'}}}
        function script:Invoke-McpCcBoundedPowerShell {param($ScriptPath,$Arguments,$WorkingDirectory,$RuntimeRoot,$TimeoutSeconds,$MaxCapturedOutputBytes) return @{exitCode=0;processId=1;stdout='{}'}}
    } $root
    $manifest=[pscustomobject]@{schemaVersion=3;codeDeployment=@{};sourcePath='fixture';components=@()}
    $holder=Launch (Join-Path $root 'holder.ps1');$null=$holder.Handle
    $watch=[Diagnostics.Stopwatch]::StartNew()
    while(-not(Test-Path (Join-Path $root 'held'))){if($watch.ElapsedMilliseconds -gt 10000){throw 'HOLDER_NOT_READY'};Start-Sleep -Milliseconds 20}
    foreach($action in @('ensure_running','reload_runtime','restart_core')){
        $message='';try{Invoke-McpCcComponentAction -Manifest $manifest -ComponentId codex_bridge -Action $action -RuntimeRoot $root -ActionTimeoutSeconds 5|Out-Null}catch{$message=$_.Exception.Message}
        Check ($message -match 'Another manager action') ($action+' serializes against updater action mutex')
    }
    Check ((& $core {$script:Reads}) -eq 0) 'rejected actions never resolve stale component'
    $message='';try{& $daily {param($r) Open-DailyTransaction $r} $root|Out-Null}catch{$message=$_.Exception.Message}
    Check ($message -eq 'DAILY_ACTION_BUSY') 'updater serializes against CC owner'
    Put (Join-Path $root 'release') '';Check ($holder.WaitForExit(5000)) 'cooperative fixture release'
    foreach($action in @('ensure_running','reload_runtime')){
        $r=Invoke-McpCcComponentAction -Manifest $manifest -ComponentId codex_bridge -Action $action -RuntimeRoot $root -ActionTimeoutSeconds 5
        Check $r.delegated 'canonical action executes after lock release'
        Check ((& $core {$script:Selected}) -eq 'B') 'fresh selector is resolved inside mutex after earlier manifest A'
    }
    & $core {$script:RequireMutex=$false}
    $null=Invoke-McpCcComponentAction -Manifest $manifest -ComponentId codex_bridge -Action reload_runtime -RuntimeRoot $root -PlanOnly
    Check (-not(Test-Path (Join-Path $root 'update.lock'))) 'PlanOnly remains read-only'

    $runtimeRoot=Join-Path $root 'codex_bridge/Runtime';[void][IO.Directory]::CreateDirectory($runtimeRoot)
    & $bridge {param($r)
        $script:FixtureRoot=$r
        function script:Get-CbCooperativeDailyLayout {param($ProjectRoot) return @{workspaceRoot=$script:FixtureRoot;version='A'}}
        function script:Assert-CbCooperativeCodePath {param($Path)}
    } $root
    $tx=& $daily {param($r) Open-DailyTransaction $r} $runtimeRoot
    $message='';try{& $bridge {Open-CbDailyMutation @{projectRoot='fixture'}}|Out-Null}catch{$message=$_.Exception.Message}
    Check ($message -match '^DAILY_UPDATE_BUSY') 'direct controller cannot mutate while real update file is held'
    & $daily {param($tx) Close-DailyTransaction $tx} $tx;$tx=$null
    $lease=& $bridge {Open-CbDailyMutation @{projectRoot='fixture'}};$lease.Dispose()
    Check (Test-Path (Join-Path $runtimeRoot 'update.lock')) 'existing unheld update.lock never blocks later entry'

    # An actually abandoned Windows mutex is acquired, then released normally.
    [IO.File]::Delete((Join-Path $root 'held'));[IO.File]::Delete((Join-Path $root 'release'))
    $holder.Dispose();$holder=Launch (Join-Path $root 'holder.ps1');$null=$holder.Handle
    while(-not(Test-Path (Join-Path $root 'held'))){Start-Sleep -Milliseconds 20}
    $retainedMutex=[Threading.Mutex]::OpenExisting('Local\McpControlCenter.Action.codex_bridge')
    try {
        $holder.Kill();[void]$holder.WaitForExit(5000)
        $tx=& $daily {param($r) Open-DailyTransaction $r} $runtimeRoot
        Check ($null -ne $tx.file) 'abandoned action mutex does not create a permanent gate'
        & $daily {param($tx) Close-DailyTransaction $tx} $tx;$tx=$null
    } finally {$retainedMutex.Dispose()}
    @{ok=$true;passed=$passed;live=$false}|ConvertTo-Json
} finally {
    if($tx){& $daily {param($tx) Close-DailyTransaction $tx} $tx}
    if($holder){if(-not $holder.HasExited){$holder.Kill();[void]$holder.WaitForExit(5000)};$holder.Dispose()}
    $resolved=[IO.Path]::GetFullPath($root)
    if((Split-Path -Parent $resolved) -ine [IO.Path]::GetTempPath().TrimEnd('\') -or (Split-Path -Leaf $resolved) -cnotmatch '^cc-daily-lock-[0-9a-f]{32}$'){throw 'UNSAFE_FIXTURE_CLEANUP'}
    if(Test-Path $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
