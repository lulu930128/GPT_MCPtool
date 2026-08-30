Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$componentRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$controllerPath = Join-Path $componentRoot "scripts\runtime-control.ps1"
$runtimeModulePath = Join-Path $componentRoot "scripts\component-runtime.psm1"
if (-not (Test-Path -LiteralPath $controllerPath -PathType Leaf)) { throw "Controller entrypoint is missing." }
if (-not (Test-Path -LiteralPath $runtimeModulePath -PathType Leaf)) { throw "Runtime module is missing." }
$runtimeModuleSource = Get-Content -LiteralPath $runtimeModulePath -Raw -Encoding UTF8
if ($runtimeModuleSource -notmatch 'owner\.json' -or $runtimeModuleSource -notmatch 'Write-EnglishStudyOwnerMetadata') {
    throw "Runtime ownership must persist PID instance metadata, not a bare PID only."
}
if ($runtimeModuleSource -notmatch 'OwnershipUnknown' -or $runtimeModuleSource -notmatch 'Remove-EnglishStudyOwnershipPair') {
    throw "Runtime ownership must fail closed on unknown evidence and guard PID/owner cleanup as a pair."
}
if ($runtimeModuleSource -notmatch 'HubArguments\s*=\s*@\("-m",\s*"english_study_hub",\s*"serve"') {
    throw "Hub lifecycle must invoke the package entrypoint that dispatches the CLI."
}
if ($runtimeModuleSource -match 'english_study_hub\.cli') {
    throw "Hub lifecycle must not invoke the non-dispatching cli module directly."
}
if ($runtimeModuleSource -notmatch 'Get-EnglishStudyLineage' -or $runtimeModuleSource -notmatch 'Get-EnglishStudyOwnedDescendants') {
    throw "Runtime ownership must validate and stop an exact Windows process lineage."
}
if ($runtimeModuleSource -notmatch 'Repair-EnglishStudyConnectivity' -or $runtimeModuleSource -notmatch 'TUNNEL_KEY_MISSING') {
    throw "Runtime must own bounded tunnel repair and fail closed when the DPAPI key is unavailable."
}
if ($runtimeModuleSource -notmatch 'Stop-EnglishStudyRole -Context \$Context -Role tunnel' -or $runtimeModuleSource -notmatch 'CONTROL_PLANE_API_KEY') {
    throw "Runtime must stop the exact tunnel role and inject its credential only into the child environment."
}
$tunnelScriptPath = Join-Path $componentRoot "scripts\tunnel.ps1"
$keyStorePath = Join-Path $componentRoot "scripts\key-store.ps1"
if (-not (Test-Path -LiteralPath $tunnelScriptPath -PathType Leaf) -or -not (Test-Path -LiteralPath $keyStorePath -PathType Leaf)) {
    throw "Component-owned tunnel and key-store scripts are missing."
}

function Get-FreeTcpPort { $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $listener.Start(); try { return ([Net.IPEndPoint]$listener.LocalEndpoint).Port } finally { $listener.Stop() } }
function Wait-TcpPort([int]$Port, [bool]$Open, [int]$Seconds = 10) { $deadline = [DateTime]::UtcNow.AddSeconds($Seconds); do { $client = New-Object Net.Sockets.TcpClient; try { $task = $client.ConnectAsync('127.0.0.1', $Port); $connected = $task.Wait(200) -and $client.Connected } catch { $connected = $false } finally { $client.Dispose() }; if ($connected -eq $Open) { return $true }; Start-Sleep -Milliseconds 100 } while ([DateTime]::UtcNow -lt $deadline); return $false }
function Stop-TestProcess($Process) { if ($null -ne $Process -and -not $Process.HasExited) { Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue; try { $Process.WaitForExit(3000) | Out-Null } catch { } } }

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("english-study-ownership-" + [Guid]::NewGuid().ToString('N'))
$hubRoot = Join-Path $testRoot 'hub'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$mcpPort = Get-FreeTcpPort
$hubPort = Get-FreeTcpPort
$tunnelPort = Get-FreeTcpPort
while ($hubPort -in @($mcpPort) -or $tunnelPort -in @($mcpPort,$hubPort)) { $hubPort = Get-FreeTcpPort; $tunnelPort = Get-FreeTcpPort }
$utf8 = New-Object Text.UTF8Encoding($false)
$foreign = $null
$staleForeign = $null
$fixtureProbe = $null
$module = $null
$context = $null
try {
    foreach ($directory in @($testRoot,$hubRoot,(Join-Path $testRoot '.tmp'),(Join-Path $testRoot 'src'),(Join-Path $testRoot 'dist\src'),(Join-Path $testRoot '.tunnel-client'),(Join-Path $testRoot '.secrets'),(Join-Path $testRoot 'scripts'))) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
    $hubChildPath = Join-Path $testRoot 'fake-hub-child.js'
    $hubRunnerPath = Join-Path $testRoot 'fake-hub-runner.js'
    $mcpEntryPath = Join-Path $testRoot 'dist\src\http-main.js'
    $tunnelPath = Join-Path $testRoot 'fake-tunnel.js'
    [IO.File]::WriteAllText((Join-Path $hubRoot 'pyproject.toml'), '[project]', $utf8)
    [IO.File]::WriteAllText((Join-Path $testRoot 'src\index.ts'), '// isolated source', $utf8)
    [IO.File]::WriteAllText($hubChildPath, 'const http=require("http");http.createServer((q,s)=>{const b=JSON.stringify({ok:true,service:"english-study-hub"});s.writeHead(200,{"content-type":"application/json"});s.end(b)}).listen(Number(process.argv[2]),"127.0.0.1");', $utf8)
    [IO.File]::WriteAllText($hubRunnerPath, 'const{spawn}=require("child_process");const{join}=require("path");const c=spawn(process.execPath,[join(__dirname,"fake-hub-child.js"),process.argv[2]],{stdio:"ignore",windowsHide:true});const x=()=>{try{c.kill()}catch{};process.exit(0)};process.on("SIGTERM",x);process.on("SIGINT",x);setInterval(()=>{},1000);', $utf8)
    [IO.File]::WriteAllText($mcpEntryPath, 'const http=require("http");http.createServer((q,s)=>{const b=JSON.stringify({ok:true,service:"english-study-mcp"});s.writeHead(200,{"content-type":"application/json"});s.end(b)}).listen(Number(process.env.ESTUDY_MCP_PORT),"127.0.0.1");', $utf8)
    [IO.File]::WriteAllText($tunnelPath, "const http=require(`"http`");http.createServer((q,s)=>s.end(q.url===`"/readyz`"?`"ready`":`"ok`")).listen($tunnelPort,`"127.0.0.1`");", $utf8)
    [IO.File]::WriteAllText((Join-Path $testRoot '.tunnel-client\test.yaml'), 'test', $utf8)
    [IO.File]::WriteAllText((Join-Path $testRoot '.secrets\test.dpapi'), 'isolated-placeholder', $utf8)
    [IO.File]::WriteAllText((Join-Path $testRoot 'scripts\key-store.ps1'), 'function Set-ControlPlaneApiKeyEnvFromSecret { $env:CONTROL_PLANE_API_KEY = ''isolated-placeholder''; return $true }', $utf8)
    $module = Import-Module $runtimeModulePath -Force -PassThru
    $context = New-EnglishStudyRuntimeContext -ProjectRoot $testRoot -HubRoot $hubRoot -NodePath $nodePath -PythonPath $nodePath -HubArguments @($hubRunnerPath,[string]$hubPort) -HubIdentity 'fake-hub-runner.js' -McpPort $mcpPort -HubPort $hubPort -TunnelClientPath $nodePath -TunnelProfileDir (Join-Path $testRoot '.tunnel-client') -TunnelProfile 'test' -TunnelHealthUrl "http://127.0.0.1:$tunnelPort" -TunnelArguments $tunnelPath -TunnelIdentity 'fake-tunnel.js' -KeyStorePath (Join-Path $testRoot 'scripts\key-store.ps1') -SecretPath (Join-Path $testRoot '.secrets\test.dpapi') -ReadyTimeoutSeconds 10 -TunnelRecoveryDelaysSeconds 5
    function Get-TestRoleState([string]$Role) { return & $module { param($RuntimeContext,$RuntimeRole) Get-EnglishStudyRoleState -Context $RuntimeContext -Role $RuntimeRole } $context $Role }

    $staleForeign = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 120') -WindowStyle Hidden -PassThru
    [IO.File]::WriteAllText($context.hubPidFile, [string]$staleForeign.Id, $utf8)
    [IO.File]::WriteAllText($context.hubOwnerFile, '{}', $utf8)
    $reused = Get-TestRoleState -Role hub
    if ($reused.state -ne 'Stopped') { throw "Reused PID without listener must be stale, got $($reused.state)." }
    if ((Test-Path -LiteralPath $context.hubPidFile) -or (Test-Path -LiteralPath $context.hubOwnerFile)) { throw 'Stale PID/owner pair was not removed.' }
    if ($null -eq (Get-Process -Id $staleForeign.Id -ErrorAction SilentlyContinue)) { throw 'Unrelated reused-PID process was stopped.' }
    Stop-TestProcess $staleForeign; $staleForeign = $null

    $staleForeign = Start-Process -FilePath $nodePath -ArgumentList @('-e','setInterval(()=>{},1000)') -WindowStyle Hidden -PassThru
    $wrongOwner = [ordered]@{ schemaVersion=1; role='mcp'; pid=$staleForeign.Id; executablePath=$nodePath; startTimeUtc=[DateTime]::UtcNow.AddDays(-1).ToString('o'); identity=$context.mcpIdentity; recordedAt=[DateTime]::UtcNow.AddDays(-1).ToString('o') }
    [IO.File]::WriteAllText($context.mcpPidFile, [string]$staleForeign.Id, $utf8)
    [IO.File]::WriteAllText($context.mcpOwnerFile, ($wrongOwner | ConvertTo-Json -Compress), $utf8)
    if ((Get-TestRoleState -Role mcp).state -ne 'Stopped') { throw 'Same executable with a different start time must be stale when listener-free.' }
    if ($null -eq (Get-Process -Id $staleForeign.Id -ErrorAction SilentlyContinue)) { throw 'Same-executable unrelated process was stopped.' }
    Stop-TestProcess $staleForeign; $staleForeign = $null

    $staleForeign = Start-Process -FilePath $nodePath -ArgumentList @('-e','setInterval(()=>{},1000)',[string]$context.mcpIdentity) -WindowStyle Hidden -PassThru
    [IO.File]::WriteAllText($context.mcpPidFile, [string]$staleForeign.Id, $utf8)
    Remove-Item -LiteralPath $context.mcpOwnerFile -Force -ErrorAction SilentlyContinue
    $unknown = Get-TestRoleState -Role mcp
    if ($unknown.state -ne 'OwnershipUnknown' -or -not (Test-Path -LiteralPath $context.mcpPidFile)) { throw 'Live exact-command process without owner metadata must remain unknown and preserve evidence.' }
    if ((Get-EnglishStudyRuntimeStatus -Context $context).status -ne 'OwnershipUnknown') { throw 'Role ownership unknown must propagate to top-level runtime status.' }
    Stop-TestProcess $staleForeign; $staleForeign = $null
    Remove-Item -LiteralPath $context.mcpPidFile,$context.mcpOwnerFile -Force -ErrorAction SilentlyContinue

    $listenerPath = Join-Path $testRoot 'fake-listener.js'
    [IO.File]::WriteAllText($listenerPath, 'const http=require("http");http.createServer((q,s)=>s.end("ok")).listen(Number(process.argv[2]),"127.0.0.1");', $utf8)
    $foreign = Start-Process -FilePath $nodePath -ArgumentList @($listenerPath,[string]$mcpPort) -WindowStyle Hidden -PassThru
    if (-not (Wait-TcpPort -Port $mcpPort -Open $true)) { throw 'Foreign listener did not start.' }
    $staleForeign = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 120') -WindowStyle Hidden -PassThru
    [IO.File]::WriteAllText($context.mcpPidFile, [string]$staleForeign.Id, $utf8)
    [IO.File]::WriteAllText($context.mcpOwnerFile, '{}', $utf8)
    $conflict = Get-TestRoleState -Role mcp
    if ($conflict.state -ne 'OwnershipMismatch' -or -not (Test-Path -LiteralPath $context.mcpPidFile)) { throw 'Foreign listener conflict must preserve stale ownership evidence.' }
    if ($null -eq (Get-Process -Id $foreign.Id -ErrorAction SilentlyContinue) -or $null -eq (Get-Process -Id $staleForeign.Id -ErrorAction SilentlyContinue)) { throw 'Foreign listener guard touched an unowned process.' }
    Stop-TestProcess $foreign; $foreign = $null
    Stop-TestProcess $staleForeign; $staleForeign = $null
    Remove-Item -LiteralPath $context.mcpPidFile,$context.mcpOwnerFile -Force -ErrorAction SilentlyContinue

    $fixtureProbe = Start-Process -FilePath $nodePath -ArgumentList @($tunnelPath) -WindowStyle Hidden -PassThru
    if (-not (Wait-TcpPort -Port $tunnelPort -Open $true)) { throw 'Tunnel fixture cannot listen before lifecycle validation.' }
    try { $fixtureResponse = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$tunnelPort/readyz" -TimeoutSec 2 -ErrorAction Stop }
    catch { throw "Tunnel fixture HTTP probe failed: $($_.Exception.Message)" }
    $fixtureContent = if ($fixtureResponse.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($fixtureResponse.Content) } else { [string]$fixtureResponse.Content }
    if ([int]$fixtureResponse.StatusCode -ne 200 -or $fixtureContent.Trim() -ne 'ready') { throw "Unexpected tunnel fixture response: $([int]$fixtureResponse.StatusCode)/$($fixtureContent.Trim())" }
    $fixtureReady = & $module { param($RuntimeContext) Test-EnglishStudyTunnelReady -Context $RuntimeContext } $context
    if (-not $fixtureReady) { throw 'Tunnel fixture does not satisfy the production readiness probe.' }
    Stop-TestProcess $fixtureProbe; $fixtureProbe = $null
    if (-not (Wait-TcpPort -Port $tunnelPort -Open $false)) { throw 'Tunnel fixture did not release its port.' }

    Invoke-EnglishStudyLifecycleAction -Context $context -Action EnsureRunning
    $ready = Get-EnglishStudyRuntimeStatus -Context $context
    if ($ready.status -ne 'Ready') { throw "Isolated lifecycle did not become Ready: $($ready.status)." }
    if ($ready.hub.relation -ne 'Descendant') { throw 'Hub listener must remain a descendant of its exact runner.' }
    if (@($ready.ownedPids).Count -ne 3) { throw 'Ready lifecycle must expose exactly three owned root PIDs.' }
    $ownedBefore = @($ready.ownedPids)
    Invoke-EnglishStudyLifecycleAction -Context $context -Action EnsureRunning
    $idempotent = Get-EnglishStudyRuntimeStatus -Context $context
    if ((@($idempotent.ownedPids) -join ',') -ne ($ownedBefore -join ',')) { throw 'Repeated EnsureRunning created a second runtime.' }
    Invoke-EnglishStudyLifecycleAction -Context $context -Action ShutdownRuntime
    if ((Get-EnglishStudyRuntimeStatus -Context $context).status -ne 'Stopped') { throw 'ShutdownRuntime did not stop the isolated runtime.' }
    Invoke-EnglishStudyLifecycleAction -Context $context -Action ShutdownRuntime
}
finally {
    Stop-TestProcess $foreign
    Stop-TestProcess $staleForeign
    Stop-TestProcess $fixtureProbe
    if ($null -ne $context) { try { Invoke-EnglishStudyLifecycleAction -Context $context -Action ShutdownRuntime } catch { } }
    if ($null -ne $module) { Remove-Module $module -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

$text = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $controllerPath -Action SelfTest
if ($LASTEXITCODE -ne 0) { throw "Controller SelfTest exited with $LASTEXITCODE." }
$document = $text | ConvertFrom-Json
$expectedCapabilities = @(
    "ensure_running"
    "repair_connectivity"
    "restart_core"
    "reload_runtime"
    "shutdown_runtime"
    "show_diagnostic_tray"
)
if ([string]$document.runtimeContract -ne "unified-lifecycle-v3") { throw "Unexpected runtime contract." }
if ((@($document.capabilities) -join ',') -ne ($expectedCapabilities -join ',')) { throw "Capability mismatch." }
if (-not [bool]$document.autoStartTunnel -or [bool]$document.credentialValuesExposed) { throw "Tunnel self-test safety contract mismatch." }
[pscustomobject]@{
    ok = $true
    component = "english_study"
    capabilities = @($document.capabilities)
    exactOwnershipEnforced = [bool]$document.exactOwnershipEnforced
} | ConvertTo-Json -Depth 5
