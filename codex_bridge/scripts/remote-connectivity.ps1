param(
  [ValidateSet('SelfTest','Lookup')][string]$Action='SelfTest',
  [string]$ProjectRoot,
  [string]$TunnelClientPath,
  [string]$TunnelProfileDir,
  [string]$TunnelProfile='codex-bridge',
  [string]$TunnelId,
  [string]$KeyStorePath='C:\GPT_MCPtool\project_reading\scripts\key-store.ps1',
  [string]$SecretPath='C:\GPT_MCPtool\project_reading\.secrets\control-plane-api-key.dpapi',
  [string]$EvidencePath,
  [ValidateRange(5,60)][int]$TimeoutSeconds=15,
  [ValidateRange(30,3600)][int]$TtlSeconds=300
)

Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
if([string]::IsNullOrWhiteSpace($ProjectRoot)){$ProjectRoot=(Resolve-Path -LiteralPath(Join-Path $PSScriptRoot '..')).Path}
$resolvedProjectRoot=[IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
if([string]::IsNullOrWhiteSpace($EvidencePath)){$EvidencePath=Join-Path $resolvedProjectRoot '.tmp\remote-registration-evidence.json'}
$EvidencePath=[IO.Path]::GetFullPath($EvidencePath)
if(-not$EvidencePath.StartsWith($resolvedProjectRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'REMOTE_EVIDENCE_PATH_INVALID: Evidence path must stay inside the component root.'}
$explicitTunnelId=if($PSBoundParameters.ContainsKey('TunnelId')){$TunnelId}else{$null};$settingsTunnelId=$null
$settingsPath=Join-Path $ProjectRoot '.local\tray-settings.json'
if(Test-Path -LiteralPath $settingsPath -PathType Leaf){
  try{$settings=Get-Content -LiteralPath $settingsPath -Encoding UTF8 -Raw|ConvertFrom-Json}catch{throw 'TUNNEL_SETTINGS_INVALID: Local tunnel settings are invalid.'}
  $property=$settings.PSObject.Properties['tunnelId'];if($null-ne$property-and-not[string]::IsNullOrWhiteSpace([string]$property.Value)){$settingsTunnelId=[string]$property.Value}
}
if([string]::IsNullOrWhiteSpace($TunnelClientPath)){$TunnelClientPath=Join-Path(Split-Path -Parent $ProjectRoot)'project_reading\vendor\tunnel-client\tunnel-client.exe'}
if([string]::IsNullOrWhiteSpace($TunnelProfileDir)){$TunnelProfileDir=Join-Path $ProjectRoot '.tunnel-client'}
$profilePath=Join-Path([IO.Path]::GetFullPath($TunnelProfileDir))"$TunnelProfile.yaml"
Import-Module(Join-Path $PSScriptRoot 'component-runtime.psm1')-Force
$identity=Resolve-CbTunnelIdentity -ExplicitTunnelId $explicitTunnelId -SettingsTunnelId $settingsTunnelId -EnvironmentTunnelId $env:CODEX_BRIDGE_TUNNEL_ID -ProfilePath $profilePath

function Write-CbRemoteEvidence{
  param([Parameter(Mandatory=$true)]$Evidence)
  $document=[ordered]@{contractVersion='component-connectivity-v1';remoteRegistration=[ordered]@{status=[string]$Evidence.status;checkedAt=[string]$Evidence.checkedAt;validUntil=[string]$Evidence.validUntil;errorCode=$Evidence.errorCode;source=[string]$Evidence.source}}
  $directory=Split-Path -Parent $EvidencePath
  if(-not(Test-Path -LiteralPath $directory -PathType Container)){New-Item -ItemType Directory -Force -Path $directory|Out-Null}
  $temporaryPath=$EvidencePath+'.tmp.'+$PID+'.'+[Guid]::NewGuid().ToString('N')
  try{[IO.File]::WriteAllText($temporaryPath,($document|ConvertTo-Json -Depth 4),(New-Object Text.UTF8Encoding($false)));Move-Item -LiteralPath $temporaryPath -Destination $EvidencePath -Force}
  finally{if(Test-Path -LiteralPath $temporaryPath -PathType Leaf){Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue}}
}

if($Action-eq'SelfTest'){
  [pscustomobject]@{contractVersion='component-connectivity-v1';producer='codex_bridge_remote_diagnostic';externalLookupOnSelfTest=$false;lookupReadOnly=$true;persistsSanitizedEvidence=$true;boundedTimeoutSeconds=$TimeoutSeconds;boundedOutputBytes=65536;tunnelIdentity=Get-CbTunnelIdentitySummary -Identity $identity;resultFields=@('status','checkedAt','validUntil','errorCode','source')}|ConvertTo-Json -Depth 5
  exit 0
}

$checkedAt=[DateTimeOffset]::UtcNow;$previousKey=[Environment]::GetEnvironmentVariable('CONTROL_PLANE_API_KEY',[EnvironmentVariableTarget]::Process)
try{
  Assert-CbTunnelIdentityReady -Context([pscustomobject]@{tunnelIdentity=$identity})
  if(-not(Test-Path -LiteralPath $TunnelClientPath -PathType Leaf)){throw 'TUNNEL_CLIENT_MISSING: tunnel-client.exe is missing.'}
  if(-not(Test-Path -LiteralPath $KeyStorePath -PathType Leaf)){throw 'TUNNEL_KEY_STORE_MISSING: Tunnel key store helper is missing.'}
  . $KeyStorePath
  Set-ControlPlaneApiKeyEnvFromSecret -ProjectRoot $ProjectRoot -SecretPath $SecretPath|Out-Null
  if([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)){throw 'TUNNEL_KEY_MISSING: Control-plane key is unavailable.'}
  $startInfo=New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName=[IO.Path]::GetFullPath($TunnelClientPath)
  $startInfo.Arguments="admin tunnels get $($identity.resolvedTunnelId) --json"
  $startInfo.WorkingDirectory=$ProjectRoot
  $startInfo.UseShellExecute=$false
  $startInfo.CreateNoWindow=$true
  $startInfo.RedirectStandardOutput=$true
  $startInfo.RedirectStandardError=$true
  $process=New-Object Diagnostics.Process;$process.StartInfo=$startInfo
  if(-not$process.Start()){throw 'TUNNEL_REMOTE_LOOKUP_FAILED: Remote diagnostic process did not start.'}
  try{
    $stdoutTask=$process.StandardOutput.ReadToEndAsync();$stderrTask=$process.StandardError.ReadToEndAsync()
    $timedOut=-not$process.WaitForExit($TimeoutSeconds*1000)
    if($timedOut){try{$process.Kill()}catch{};$process.WaitForExit()}
    $stdout=$stdoutTask.GetAwaiter().GetResult();$stderr=$stderrTask.GetAwaiter().GetResult();$combined=([string]$stdout)+[Environment]::NewLine+([string]$stderr)
    $evidence=ConvertTo-CbRemoteRegistrationEvidence -ExitCode $(if($timedOut){-1}else{$process.ExitCode}) -Output $combined -TimedOut:$timedOut -ExpectedTunnelId $identity.resolvedTunnelId -CheckedAtUtc $checkedAt -TtlSeconds $TtlSeconds
  }finally{$process.Dispose()}
  Write-CbRemoteEvidence -Evidence $evidence
  $evidence|ConvertTo-Json -Depth 3
  if($evidence.status-ne'Ready'){exit 1};exit 0
}
catch{
  $raw=([string]$_.Exception.Message-replace'[\r\n]+',' ').Trim();$code=if($raw-match'^([A-Z][A-Z0-9_]{0,63}):'){$matches[1]}else{'TUNNEL_REMOTE_LOOKUP_FAILED'}
  $allowed=@('TUNNEL_PROFILE_MISSING','TUNNEL_PROFILE_INVALID','TUNNEL_ID_MISSING','TUNNEL_ID_INVALID','TUNNEL_ID_MISMATCH','TUNNEL_CLIENT_MISSING','TUNNEL_KEY_STORE_MISSING','TUNNEL_KEY_MISSING','TUNNEL_REMOTE_LOOKUP_FAILED')
  if($code-notin$allowed){$code='TUNNEL_REMOTE_LOOKUP_FAILED'}
  $failureEvidence=[pscustomobject]@{status='Failed';checkedAt=$checkedAt.ToUniversalTime().ToString('o');validUntil=$checkedAt.ToUniversalTime().AddSeconds($TtlSeconds).ToString('o');errorCode=$code;source='codex_bridge_remote_diagnostic'}
  try{Write-CbRemoteEvidence -Evidence $failureEvidence}catch{}
  $failureEvidence|ConvertTo-Json -Depth 3
  exit 1
}
finally{[Environment]::SetEnvironmentVariable('CONTROL_PLANE_API_KEY',$previousKey,[EnvironmentVariableTarget]::Process)}
