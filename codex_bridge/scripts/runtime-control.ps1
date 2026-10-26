param(
  [ValidateSet('SelfTest','InstalledBinding','Status','EnsureRunning','RepairConnectivity','RestartCore','ReloadRuntime','ShutdownRuntime')][string]$Action='Status',
  [string]$ProjectRoot,[string]$HostName='127.0.0.1',[int]$Port=18828,[string]$ProjectsFile,[string]$DataDir,[string]$Token=$env:CODEX_BRIDGE_HTTP_TOKEN,
  [string]$CodexCommand,[string]$CodexArgs,[string]$NodePath,[string]$TunnelClientPath,[string]$TunnelProfileDir,[string]$TunnelProfile='codex-bridge',[string]$TunnelId,[string]$TunnelHealthUrl='http://127.0.0.1:18829',
  [string]$KeyStorePath='C:\GPT_MCPtool\project_reading\scripts\key-store.ps1',[string]$SecretPath='C:\GPT_MCPtool\project_reading\.secrets\control-plane-api-key.dpapi',[string]$ExpectedBuildId,[string]$TestActiveFlag,
  [int]$ServerReadyTimeoutSeconds=20,[int[]]$TunnelRecoveryDelaysSeconds=@(15,30,60),[switch]$AdoptLegacyExactListeners,[switch]$RequireAllJobs
)

Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\mcp_control_center\config\installed-release.json')) {
  $env:PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
}
if([string]::IsNullOrWhiteSpace($ProjectRoot)){$ProjectRoot=(Resolve-Path -LiteralPath(Join-Path $PSScriptRoot '..')).Path}
# Inspect the physically loaded installation before reading any writable tray settings.
$installedModule=Import-Module (Join-Path $PSScriptRoot 'codex-bridge-runtime.psm1') -PassThru
$isInstalled=& $installedModule {Test-CbInstalledLayout}
if($isInstalled){
  if(@($PSBoundParameters.Keys|Where-Object{$_ -notin @('Action','ProjectRoot')}).Count -gt 0 -or
    [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\') -ine (Split-Path -Parent $PSScriptRoot)){throw 'INSTALLED_CALLER_OVERRIDE_REJECTED'}
  if($Action -eq 'InstalledBinding'){
    & $installedModule {$b=Get-CbInstalledBinding; if($b.activationReady){Assert-McpCcInstalledSelection $b};$b} | ConvertTo-Json -Depth 5
    exit 0
  }
  # Status is intentionally static until cutover/runtime binding is complete, without
  # health probes, legacy adoption, logs, secret reads or mutex/process side effects.
  $releasePath=Join-Path (Split-Path -Parent $ProjectRoot) 'mcp_control_center\config\installed-release.json'
  if((Get-Item -LiteralPath $releasePath).Length -gt 16384){throw 'INSTALLED_MANIFEST_LIMIT'}
  $releaseVersion=(Get-Content -LiteralPath $releasePath -Raw -Encoding UTF8|ConvertFrom-Json).schemaVersion
  if($releaseVersion -notin @(3,4,5,6)){
    [pscustomobject]@{ok=$false;action=$Action;code='INSTALLED_LIFECYCLE_BINDINGS_REQUIRED';componentLaunches=0}|ConvertTo-Json
    if($Action -in @('Status','SelfTest')){exit 0}else{exit 1}
  }
  $context=New-CodexBridgeRuntimeContext -ProjectRoot $ProjectRoot
  & $installedModule {param($c) Assert-CbInstalledMutationBlocked $c} $context
}
elseif($Action -eq 'InstalledBinding'){throw 'INSTALLED_RELEASE_REQUIRED'}
if(-not $isInstalled -and (Test-Path -LiteralPath (Join-Path $ProjectRoot '..\daily-mode.json'))){
  . (Join-Path $PSScriptRoot 'daily-runtime-settings.ps1')
  if(@($PSBoundParameters.Keys | Where-Object {$_ -notin @('Action','ProjectRoot')}).Count){throw 'DAILY_CALLER_OVERRIDE_REJECTED'}
  $context=New-CbDailyContext $ProjectRoot -RequireBearer:($Action -in @('EnsureRunning','RepairConnectivity','RestartCore','ReloadRuntime'))
}
elseif(-not $isInstalled){
$explicitTunnelId=if($PSBoundParameters.ContainsKey('TunnelId')){$TunnelId}else{$null};$settingsTunnelId=$null

$settingsPath=Join-Path $ProjectRoot '.local\tray-settings.json'
if(Test-Path -LiteralPath $settingsPath -PathType Leaf){
  try{$settings=Get-Content -LiteralPath $settingsPath -Encoding UTF8 -Raw|ConvertFrom-Json}catch{throw 'Invalid local tray settings.'}
  $tunnelIdProperty=$settings.PSObject.Properties['tunnelId'];if($null-ne$tunnelIdProperty-and-not[string]::IsNullOrWhiteSpace([string]$tunnelIdProperty.Value)){$settingsTunnelId=[string]$tunnelIdProperty.Value}
  foreach($binding in @(@{Parameter='ProjectsFile';Name='projectsFile'},@{Parameter='DataDir';Name='dataDir'},@{Parameter='CodexCommand';Name='codexCommand'},@{Parameter='CodexArgs';Name='codexArgs'})){
    $property=$settings.PSObject.Properties[$binding.Name]
    if(-not$PSBoundParameters.ContainsKey($binding.Parameter)-and$null-ne$property-and-not[string]::IsNullOrWhiteSpace([string]$property.Value)){Set-Variable -Name $binding.Parameter -Value([string]$property.Value)}
  }
}

Import-Module(Join-Path $PSScriptRoot 'component-runtime.psm1')-Force
$context=New-CodexBridgeRuntimeContext -ProjectRoot $ProjectRoot -HostName $HostName -Port $Port -ProjectsFile $ProjectsFile -DataDir $DataDir -Token $Token -CodexCommand $CodexCommand -CodexArgs $CodexArgs -NodePath $NodePath -TunnelClientPath $TunnelClientPath -TunnelProfileDir $TunnelProfileDir -TunnelProfile $TunnelProfile -ExplicitTunnelId $explicitTunnelId -SettingsTunnelId $settingsTunnelId -EnvironmentTunnelId $env:CODEX_BRIDGE_TUNNEL_ID -TunnelHealthUrl $TunnelHealthUrl -KeyStorePath $KeyStorePath -SecretPath $SecretPath -ExpectedBuildId $ExpectedBuildId -TestActiveFlag $TestActiveFlag -ServerReadyTimeoutSeconds $ServerReadyTimeoutSeconds -TunnelRecoveryDelaysSeconds $TunnelRecoveryDelaysSeconds
if($RequireAllJobs){$context|Add-Member -NotePropertyName requireAllJobs -NotePropertyValue $true}
}

if($Action-eq'SelfTest'){
  $capabilities=@('ensure_running','repair_connectivity','restart_core','reload_runtime','shutdown_runtime');if(-not $isInstalled){$capabilities+='show_diagnostic_tray'}
  [pscustomobject]@{runtimeContract='unified-lifecycle-v3';lifecycleModel='stateless-controller';supportsDiagnosticTray=(-not $isInstalled);controllerEntryExists=Test-Path -LiteralPath $PSCommandPath -PathType Leaf;autoStartCore=$true;autoStartTunnel=$true;exitUiStopsRuntime=$false;exactOwnershipEnforced=$true;tunnelIdentityConsistencyEnforced=$true;tunnelIdentity=Get-CbTunnelIdentitySummary -Identity $context.tunnelIdentity;activeWorkMutationBlocked=$true;approvalDecisionsDelegated=$false;capabilities=$capabilities;resultFields=@('ok','action','before','after','ownedPids','elapsedMs','errorCode','message')}|ConvertTo-Json -Depth 5
  exit 0
}

$mutex=$null;$acquired=$false;$clock=[Diagnostics.Stopwatch]::StartNew();$before=$null;$after=$null
try{
  if($Action-eq'Status'){
    if($AdoptLegacyExactListeners){throw 'READONLY_ADOPTION_REJECTED: Status cannot adopt ownership.'}
  }else{
    $mutex=New-Object Threading.Mutex($false,'Local\CodexBridgeMcpRuntimeControl')
    try{$acquired=$mutex.WaitOne(0,$false)}catch [Threading.AbandonedMutexException]{$acquired=$true}
    if(-not$acquired){throw 'ACTION_BUSY: Another Codex Bridge lifecycle action is running.'}
  }
  $before=Get-CodexBridgeRuntimeStatus -Context $context -AdoptLegacyExactListeners:$AdoptLegacyExactListeners
  if($Action-ne'Status'){Invoke-CodexBridgeLifecycleAction -Context $context -Action $Action}
  $after=Get-CodexBridgeRuntimeStatus -Context $context;$clock.Stop();$result=[pscustomobject]@{ok=$true;action=$Action;before=$before;after=$after;ownedPids=@($after.ownedPids);elapsedMs=[int]$clock.ElapsedMilliseconds;errorCode=$null;message=$(if($Action-eq'Status'){'Status checked.'}else{'Lifecycle action completed.'})}
  if($Action -ne 'Status'){Write-CodexBridgeLifecycleEvent -Context $context -Action $Action -Ok $true -BeforeStatus $before.status -AfterStatus $after.status -OwnedPids @($after.ownedPids) -ElapsedMs $result.elapsedMs -Message $result.message}
  $result|ConvertTo-Json -Depth 9;exit 0
}
catch{
  $clock.Stop();$raw=([string]$_.Exception.Message-replace'[\r\n]+',' ').Trim();if($raw-match'^([A-Z][A-Z0-9_]+):\s*(.*)$'){$errorCode=$matches[1];$message=$matches[2]}else{$errorCode='ACTION_FAILED';$message='Lifecycle action failed; inspect the component runtime log.'};try{$after=Get-CodexBridgeRuntimeStatus -Context $context}catch{$after=$null};$owned=if($null-eq$after){@()}else{@($after.ownedPids)};try{if($Action -ne 'Status'){Write-CodexBridgeLifecycleEvent -Context $context -Action $Action -Ok $false -BeforeStatus $(if($null-eq$before){$null}else{$before.status}) -AfterStatus $(if($null-eq$after){$null}else{$after.status}) -OwnedPids $owned -ElapsedMs([int]$clock.ElapsedMilliseconds)-ErrorCode $errorCode -Message $message}}catch{};[pscustomobject]@{ok=$false;action=$Action;before=$before;after=$after;ownedPids=$owned;elapsedMs=[int]$clock.ElapsedMilliseconds;errorCode=$errorCode;message=$message}|ConvertTo-Json -Depth 9;exit 1
}
finally{if($acquired){$mutex.ReleaseMutex()};if($null-ne$mutex){$mutex.Dispose()}}
