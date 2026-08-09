param(
  [ValidateSet('SelfTest','Status','EnsureRunning','RepairConnectivity','RestartCore','ReloadRuntime','ShutdownRuntime')][string]$Action='Status',
  [string]$ProjectRoot,[string]$HostName='127.0.0.1',[int]$Port=8828,[string]$ProjectsFile,[string]$DataDir='C:\CodexBridge',[string]$Token=$env:CODEX_BRIDGE_HTTP_TOKEN,
  [string]$CodexCommand,[string]$CodexArgs,[string]$NodePath,[string]$TunnelClientPath,[string]$TunnelProfileDir,[string]$TunnelProfile='codex-bridge',[string]$TunnelHealthUrl='http://127.0.0.1:8829',
  [string]$KeyStorePath='C:\GPT_MCPtool\project_reading\scripts\key-store.ps1',[string]$SecretPath='C:\GPT_MCPtool\project_reading\.secrets\control-plane-api-key.dpapi',[string]$ExpectedBuildId,[string]$TestActiveFlag,
  [int]$ServerReadyTimeoutSeconds=20,[int[]]$TunnelRecoveryDelaysSeconds=@(15,30,60),[switch]$AdoptLegacyExactListeners
)

Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
if([string]::IsNullOrWhiteSpace($ProjectRoot)){$ProjectRoot=(Resolve-Path -LiteralPath(Join-Path $PSScriptRoot '..')).Path}

$settingsPath=Join-Path $ProjectRoot '.local\tray-settings.json'
if(Test-Path -LiteralPath $settingsPath -PathType Leaf){
  try{$settings=Get-Content -LiteralPath $settingsPath -Encoding UTF8 -Raw|ConvertFrom-Json}catch{throw 'Invalid local tray settings.'}
  foreach($binding in @(@{Parameter='ProjectsFile';Name='projectsFile'},@{Parameter='DataDir';Name='dataDir'},@{Parameter='CodexCommand';Name='codexCommand'},@{Parameter='CodexArgs';Name='codexArgs'})){
    $property=$settings.PSObject.Properties[$binding.Name]
    if(-not$PSBoundParameters.ContainsKey($binding.Parameter)-and$null-ne$property-and-not[string]::IsNullOrWhiteSpace([string]$property.Value)){Set-Variable -Name $binding.Parameter -Value([string]$property.Value)}
  }
}

Import-Module(Join-Path $PSScriptRoot 'component-runtime.psm1')-Force
$context=New-CodexBridgeRuntimeContext -ProjectRoot $ProjectRoot -HostName $HostName -Port $Port -ProjectsFile $ProjectsFile -DataDir $DataDir -Token $Token -CodexCommand $CodexCommand -CodexArgs $CodexArgs -NodePath $NodePath -TunnelClientPath $TunnelClientPath -TunnelProfileDir $TunnelProfileDir -TunnelProfile $TunnelProfile -TunnelHealthUrl $TunnelHealthUrl -KeyStorePath $KeyStorePath -SecretPath $SecretPath -ExpectedBuildId $ExpectedBuildId -TestActiveFlag $TestActiveFlag -ServerReadyTimeoutSeconds $ServerReadyTimeoutSeconds -TunnelRecoveryDelaysSeconds $TunnelRecoveryDelaysSeconds

if($Action-eq'SelfTest'){
  [pscustomobject]@{runtimeContract='unified-lifecycle-v3';lifecycleModel='stateless-controller';supportsDiagnosticTray=$true;controllerEntryExists=Test-Path -LiteralPath $PSCommandPath -PathType Leaf;autoStartCore=$true;autoStartTunnel=$true;exitUiStopsRuntime=$false;exactOwnershipEnforced=$true;activeWorkMutationBlocked=$true;approvalDecisionsDelegated=$false;capabilities=@('ensure_running','repair_connectivity','restart_core','reload_runtime','shutdown_runtime','show_diagnostic_tray');resultFields=@('ok','action','before','after','ownedPids','elapsedMs','errorCode','message')}|ConvertTo-Json -Depth 5
  exit 0
}

$mutex=New-Object Threading.Mutex($false,'Local\CodexBridgeMcpRuntimeControl');$acquired=$false;$clock=[Diagnostics.Stopwatch]::StartNew();$before=$null;$after=$null
try{
  try{$acquired=$mutex.WaitOne(0,$false)}catch [Threading.AbandonedMutexException]{$acquired=$true}
  if(-not$acquired){throw 'ACTION_BUSY: Another Codex Bridge lifecycle action is running.'}
  $before=Get-CodexBridgeRuntimeStatus -Context $context -AdoptLegacyExactListeners:$AdoptLegacyExactListeners
  if($Action-ne'Status'){Invoke-CodexBridgeLifecycleAction -Context $context -Action $Action}
  $after=Get-CodexBridgeRuntimeStatus -Context $context;$clock.Stop();$result=[pscustomobject]@{ok=$true;action=$Action;before=$before;after=$after;ownedPids=@($after.ownedPids);elapsedMs=[int]$clock.ElapsedMilliseconds;errorCode=$null;message=$(if($Action-eq'Status'){'Status checked.'}else{'Lifecycle action completed.'})}
  Write-CodexBridgeLifecycleEvent -Context $context -Action $Action -Ok $true -BeforeStatus $before.status -AfterStatus $after.status -OwnedPids @($after.ownedPids) -ElapsedMs $result.elapsedMs -Message $result.message
  $result|ConvertTo-Json -Depth 9;exit 0
}
catch{
  $clock.Stop();$raw=([string]$_.Exception.Message-replace'[\r\n]+',' ').Trim();if($raw-match'^([A-Z][A-Z0-9_]+):\s*(.*)$'){$errorCode=$matches[1];$message=$matches[2]}else{$errorCode='ACTION_FAILED';$message='Lifecycle action failed; inspect the component runtime log.'};try{$after=Get-CodexBridgeRuntimeStatus -Context $context}catch{$after=$null};$owned=if($null-eq$after){@()}else{@($after.ownedPids)};try{Write-CodexBridgeLifecycleEvent -Context $context -Action $Action -Ok $false -BeforeStatus $(if($null-eq$before){$null}else{$before.status}) -AfterStatus $(if($null-eq$after){$null}else{$after.status}) -OwnedPids $owned -ElapsedMs([int]$clock.ElapsedMilliseconds)-ErrorCode $errorCode -Message $message}catch{};[pscustomobject]@{ok=$false;action=$Action;before=$before;after=$after;ownedPids=$owned;elapsedMs=[int]$clock.ElapsedMilliseconds;errorCode=$errorCode;message=$message}|ConvertTo-Json -Depth 9;exit 1
}
finally{if($acquired){$mutex.ReleaseMutex()};$mutex.Dispose()}
