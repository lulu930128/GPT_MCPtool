Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$script:Passed = 0
function Assert-True([bool]$Condition, [string]$Message) { if (-not $Condition) { throw "Assertion failed: $Message" }; $script:Passed++ }
function Assert-Equal($Actual, $Expected, [string]$Message) { if ([string]$Actual -ne [string]$Expected) { throw "Assertion failed: $Message. Expected '$Expected', got '$Actual'." }; $script:Passed++ }

$sourceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$stackSource = [IO.File]::ReadAllText((Join-Path $sourceRoot 'scripts\memory_core_stack.ps1'))
Assert-True ($stackSource -match '(?s)Start-MemoryCoreChildProcess\s+`\s*\r?\n\s*-FilePath \$TunnelClientPath.+?-RedirectStandardOutput.+?-RedirectStandardError') 'tunnel child detaches stdout and stderr from the lifecycle controller capture'
$runtimeSource = [IO.File]::ReadAllText((Join-Path $sourceRoot 'scripts\memory-core-runtime.psm1'))
Assert-True ($runtimeSource -match '(?s)stack-captures.+?RedirectStandardOutput \$stdoutPath.+?RedirectStandardError \$stderrPath') 'stack actions use file capture instead of anonymous controller pipes'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("memory-core-controller-" + [Guid]::NewGuid().ToString('N'))
$utf8 = New-Object Text.UTF8Encoding($false)
$context = $null

try {
    foreach ($directory in @('scripts', 'tests', '.tmp')) { New-Item -ItemType Directory -Force -Path (Join-Path $testRoot $directory) | Out-Null }
    foreach ($name in @('memory-core-runtime.psm1', 'component-runtime.psm1', 'runtime-control.ps1')) { Copy-Item -LiteralPath (Join-Path $sourceRoot "scripts\$name") -Destination (Join-Path $testRoot "scripts\$name") }
    $fakeStack = @'
param([ValidateSet("Status","Start","StartTunnel","StopTunnel","RestartCore","Restart","Stop")][string]$Action="Status",[int]$BackendPort=18765)
$ErrorActionPreference="Stop"
$statePath=Join-Path $PSScriptRoot "..\fake-state.json"
$logPath=Join-Path $PSScriptRoot "..\fake-actions.log"
function New-Role([bool]$Ready,[int]$RolePid){
  $role=[ordered]@{healthy=$Ready;ready=$Ready;pid=$null;pidState="missing";listenerPids=@()}
  if($RolePid -gt 0){$role.pid=$RolePid;$role.pidState="owned";$role.listenerPids=@($RolePid)}
  return $role
}
if(Test-Path $statePath){$state=[IO.File]::ReadAllText($statePath)|ConvertFrom-Json}else{$state=[pscustomobject]@{counter=1000;backend=(New-Role $false 0);mcp=(New-Role $false 0);tunnel=(New-Role $false 0)}}
function Start-Role($Role,[string]$ReadyField){$state.counter=[int]$state.counter+1;$Role.pid=[int]$state.counter;$Role.pidState="owned";$Role.listenerPids=@([int]$state.counter);$Role.$ReadyField=$true}
switch($Action){
  "Start"{Start-Role $state.backend "healthy";Start-Role $state.mcp "healthy";Start-Role $state.tunnel "ready"}
  "StartTunnel"{Start-Role $state.tunnel "ready"}
  "StopTunnel"{$state.tunnel=(New-Role $false 0)}
  "RestartCore"{Start-Role $state.backend "healthy";Start-Role $state.mcp "healthy"}
  "Restart"{Start-Role $state.backend "healthy";Start-Role $state.mcp "healthy";Start-Role $state.tunnel "ready"}
  "Stop"{$state.backend=(New-Role $false 0);$state.mcp=(New-Role $false 0);$state.tunnel=(New-Role $false 0)}
}
[IO.File]::WriteAllText($statePath,($state|ConvertTo-Json -Depth 6),(New-Object Text.UTF8Encoding($false)))
Add-Content -LiteralPath $logPath -Value $Action -Encoding UTF8
if($Action -eq "Start" -and (Test-Path (Join-Path $PSScriptRoot "..\inherit-stack-handles.flag"))){
  $startInfo=New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName=Join-Path $PSHOME "powershell.exe"
  $startInfo.Arguments='-NoProfile -Command "Start-Sleep -Seconds 15"'
  $startInfo.UseShellExecute=$false
  $startInfo.CreateNoWindow=$true
  $child=[Diagnostics.Process]::Start($startInfo)
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot "..\inherited-child.pid"),[string]$child.Id,(New-Object Text.UTF8Encoding($false)))
}
[ordered]@{backend=$state.backend;mcp=$state.mcp;tunnel=$state.tunnel;secrets=[ordered]@{mcpClientToken="isolated-secret-placeholder";storage="Windows DPAPI current-user"};privatePath="C:\private\memory-core.db";payload="record body"}|ConvertTo-Json -Depth 7
'@
    $fakeStackPath = Join-Path $testRoot 'scripts\fake-stack.ps1'
    [IO.File]::WriteAllText($fakeStackPath, $fakeStack, $utf8)
    $controller = Join-Path $testRoot 'scripts\runtime-control.ps1'
    $powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    Import-Module (Join-Path $testRoot 'scripts\component-runtime.psm1') -Force
    $context = New-MemoryCoreRuntimeContext -ProjectRoot $testRoot -StackScript $fakeStackPath -PowershellPath $powershellPath -ActionTimeoutSeconds 20

    function Invoke-TestController([string]$Action, [bool]$ExpectSuccess = $true) {
        if ($Action -eq 'SelfTest') {
            $document = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $controller -Action SelfTest -ProjectRoot $testRoot -StackScript $fakeStackPath -PowershellPath $powershellPath -ActionTimeoutSeconds 20) | ConvertFrom-Json
            $exitCode = $LASTEXITCODE
            Assert-Equal $exitCode 0 'SelfTest exits successfully'
            return [pscustomobject]@{ document = $document; exitCode = $exitCode }
        }
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $before = Get-MemoryCoreRuntimeStatus -Context $context
        $errorCode = $null; $message = 'Lifecycle action completed.'; $diagnostic = $null
        try { if ($Action -ne 'Status') { Invoke-MemoryCoreLifecycleAction -Context $context -Action $Action }; $exitCode = 0 }
        catch {
            $exitCode = 1
            $raw = ([string]$_.Exception.Message -replace '[\r\n]+', ' ').Trim()
            $diagnostic = $raw
            if ($raw -match '^([A-Z][A-Z0-9_]+):\s*(.*)$') { $errorCode = $matches[1]; $message = $matches[2] }
            else { $errorCode = 'ACTION_FAILED'; $message = 'Lifecycle action failed.' }
        }
        $after = Get-MemoryCoreRuntimeStatus -Context $context
        $clock.Stop()
        $document = [pscustomobject]@{ ok = ($exitCode -eq 0); action = $Action; before = $before; after = $after; ownedPids = @($after.ownedPids); elapsedMs = [int]$clock.ElapsedMilliseconds; errorCode = $errorCode; message = $message }
        Write-MemoryCoreLifecycleEvent -Context $context -Action $Action -Ok ($exitCode -eq 0) -BeforeStatus $before.status -AfterStatus $after.status -OwnedPids @($after.ownedPids) -ElapsedMs $document.elapsedMs -ErrorCode $errorCode -Message $message
        if ($ExpectSuccess) { Assert-Equal $exitCode 0 "$Action exits successfully (errorCode=$errorCode diagnostic=$diagnostic)" } else { Assert-True ($exitCode -ne 0) "$Action fails safely" }
        return [pscustomobject]@{ document = $document; exitCode = $exitCode }
    }

    $self = Invoke-TestController SelfTest
    Assert-Equal $self.document.runtimeContract 'unified-lifecycle-v3' 'SelfTest contract is v3'
    Assert-Equal (@($self.document.orderedCoreRoles) -join ',') 'backend,mcp' 'SelfTest declares ordered core roles'
    Assert-Equal $self.document.managerDomainDataAccess 'none' 'SelfTest declares no domain access'
    Assert-Equal $self.document.formalDataPathExposed $false 'SelfTest declares data-path redaction'
    Assert-True ((($self.document | ConvertTo-Json -Depth 8).IndexOf($testRoot, [StringComparison]::OrdinalIgnoreCase)) -lt 0) 'SelfTest omits test paths'

    $initial = Invoke-TestController Status
    Assert-Equal $initial.document.after.status 'Stopped' 'isolated facade starts stopped'
    $ensure = Invoke-TestController EnsureRunning
    Assert-Equal $ensure.document.after.status 'Ready' 'ensure starts all stack roles'
    Assert-True (@($ensure.document.after.ownedPids).Count -eq 3) 'three managed role PIDs are sanitized'
    $backend1=[int]$ensure.document.after.backend.pid; $mcp1=[int]$ensure.document.after.mcp.pid; $tunnel1=[int]$ensure.document.after.tunnel.pid

    $ensureAgain = Invoke-TestController EnsureRunning
    Assert-Equal $ensureAgain.document.after.backend.pid $backend1 'idempotent ensure preserves backend'
    Assert-Equal $ensureAgain.document.after.mcp.pid $mcp1 'idempotent ensure preserves MCP'
    Assert-Equal $ensureAgain.document.after.tunnel.pid $tunnel1 'idempotent ensure preserves tunnel'

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $fakeStackPath -Action StopTunnel | Out-Null
    $repair = Invoke-TestController RepairConnectivity
    Assert-Equal $repair.document.after.status 'Ready' 'repair restores only connectivity'
    Assert-Equal $repair.document.after.backend.pid $backend1 'repair preserves backend'
    Assert-Equal $repair.document.after.mcp.pid $mcp1 'repair preserves MCP'
    Assert-True ([int]$repair.document.after.tunnel.pid -ne $tunnel1) 'repair replaces tunnel'
    $tunnel2=[int]$repair.document.after.tunnel.pid

    $restart = Invoke-TestController RestartCore
    Assert-Equal $restart.document.after.status 'Ready' 'core restart returns Ready'
    Assert-True ([int]$restart.document.after.backend.pid -ne $backend1) 'core restart replaces backend'
    Assert-True ([int]$restart.document.after.mcp.pid -ne $mcp1) 'core restart replaces MCP'
    Assert-Equal $restart.document.after.tunnel.pid $tunnel2 'core restart preserves tunnel'
    $backend2=[int]$restart.document.after.backend.pid; $mcp2=[int]$restart.document.after.mcp.pid

    $reload = Invoke-TestController ReloadRuntime
    Assert-Equal $reload.document.after.status 'Ready' 'reload returns Ready'
    Assert-True ([int]$reload.document.after.backend.pid -ne $backend2) 'reload replaces backend'
    Assert-True ([int]$reload.document.after.mcp.pid -ne $mcp2) 'reload replaces MCP'
    Assert-True ([int]$reload.document.after.tunnel.pid -ne $tunnel2) 'reload replaces tunnel'

    $shutdown = Invoke-TestController ShutdownRuntime
    Assert-Equal $shutdown.document.after.status 'Stopped' 'shutdown stops all roles'
    $shutdownAgain = Invoke-TestController ShutdownRuntime
    Assert-Equal $shutdownAgain.document.after.status 'Stopped' 'shutdown is idempotent'

    New-Item -ItemType File -Path (Join-Path $testRoot 'inherit-stack-handles.flag') -Force | Out-Null
    $detachedClock = [Diagnostics.Stopwatch]::StartNew()
    $detachedEnsure = Invoke-TestController EnsureRunning
    $detachedClock.Stop()
    Assert-Equal $detachedEnsure.document.after.status 'Ready' 'ensure succeeds while a descendant retains inherited stack handles'
    Assert-True ($detachedClock.ElapsedMilliseconds -lt 10000) 'file capture prevents inherited handles from blocking controller completion'
    $inheritedChildPidPath = Join-Path $testRoot 'inherited-child.pid'
    Assert-True (Test-Path -LiteralPath $inheritedChildPidPath) 'inherited-handle fixture records its exact child PID'
    $inheritedChildPid = [int]([IO.File]::ReadAllText($inheritedChildPidPath).Trim())
    Stop-Process -Id $inheritedChildPid -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $testRoot 'inherit-stack-handles.flag') -Force -ErrorAction SilentlyContinue

    $statePath = Join-Path $testRoot 'fake-state.json'
    $actionLogPath = Join-Path $testRoot 'fake-actions.log'
    $state = [IO.File]::ReadAllText($statePath) | ConvertFrom-Json
    $state.mcp.healthy=$false; $state.mcp.pid=$null; $state.mcp.pidState='stale_process_name'; $state.mcp.listenerPids=@()
    [IO.File]::WriteAllText($statePath,($state|ConvertTo-Json -Depth 6),$utf8)
    $startCountBefore = @(Get-Content $actionLogPath | Where-Object { $_ -eq 'Start' }).Count
    $stalePidEnsure = Invoke-TestController EnsureRunning
    Assert-Equal $stalePidEnsure.document.before.mcp.ownership 'Stopped' 'reused stale PID without a listener is treated as stopped'
    Assert-Equal $stalePidEnsure.document.after.status 'Ready' 'ensure recovers from a PID reused by another process'
    $startCountAfter = @(Get-Content $actionLogPath | Where-Object { $_ -eq 'Start' }).Count
    Assert-Equal $startCountAfter ($startCountBefore + 1) 'stale PID recovery delegates one bounded Start to the stack'

    $state = [IO.File]::ReadAllText($statePath) | ConvertFrom-Json
    $state.mcp.healthy=$false; $state.mcp.pid=$null; $state.mcp.pidState='stale_executable'; $state.mcp.listenerPids=@()
    [IO.File]::WriteAllText($statePath,($state|ConvertTo-Json -Depth 6),$utf8)
    $staleExecutable = Invoke-TestController Status
    Assert-Equal $staleExecutable.document.after.mcp.ownership 'Stopped' 'stale executable without a listener is treated as stopped'

    $state.mcp.pidState='stale_process_name'; $state.mcp.listenerPids=@(9999)
    [IO.File]::WriteAllText($statePath,($state|ConvertTo-Json -Depth 6),$utf8)
    $stopCountBefore = @(Get-Content $actionLogPath | Where-Object { $_ -eq 'Stop' }).Count
    $staleWithListener = Invoke-TestController ShutdownRuntime $false
    Assert-Equal $staleWithListener.document.errorCode 'OWNERSHIP_MISMATCH' 'stale PID with an unexpected listener still blocks shutdown'
    $stopCountAfter = @(Get-Content $actionLogPath | Where-Object { $_ -eq 'Stop' }).Count
    Assert-Equal $stopCountAfter $stopCountBefore 'stale PID with a listener is not delegated to the stack'

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $fakeStackPath -Action Start | Out-Null
    $state = [IO.File]::ReadAllText($statePath) | ConvertFrom-Json
    $state.backend.healthy=$true; $state.backend.pid=$null; $state.backend.pidState='ownership_unverified'; $state.backend.listenerPids=@(9999)
    [IO.File]::WriteAllText($statePath,($state|ConvertTo-Json -Depth 6),$utf8)
    $stopCountBefore = @(Get-Content $actionLogPath | Where-Object { $_ -eq 'Stop' }).Count
    $foreign = Invoke-TestController ShutdownRuntime $false
    Assert-Equal $foreign.document.errorCode 'OWNERSHIP_MISMATCH' 'unverified owner blocks shutdown'
    $stopCountAfter = @(Get-Content $actionLogPath | Where-Object { $_ -eq 'Stop' }).Count
    Assert-Equal $stopCountAfter $stopCountBefore 'blocked shutdown is not delegated to stack'

    $auditText = [IO.File]::ReadAllText((Join-Path $testRoot '.tmp\runtime-control.jsonl'))
    Assert-True ($auditText.IndexOf('isolated-secret-placeholder', [StringComparison]::Ordinal) -lt 0) 'audit excludes secret material'
    Assert-True ($auditText.IndexOf('C:\private\memory-core.db', [StringComparison]::OrdinalIgnoreCase) -lt 0) 'audit excludes private path'
    Assert-True ($auditText.IndexOf('record body', [StringComparison]::Ordinal) -lt 0) 'audit excludes domain payload'

    [pscustomobject]@{ok=$true;assertions=$script:Passed;actions=@('SelfTest','Status','EnsureRunning','RepairConnectivity','RestartCore','ReloadRuntime','ShutdownRuntime','ForeignOwnerGuard')} | ConvertTo-Json -Depth 4
}
finally {
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
