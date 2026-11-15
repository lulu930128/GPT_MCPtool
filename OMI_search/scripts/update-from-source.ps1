param(
  [ValidateSet('Preview','Update','Recover')][string]$Action = 'Preview',
  [string]$RequestId,
  [string]$VersionId,
  [string]$ExpectedSourceDigest
)
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $root '..\project_reading\scripts\component-update-common.ps1')
$descriptor = Read-ComponentUpdateJson (Join-Path $root 'control-center\update.json')
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$mutex = $null
$acquired = $false
$operationRoot = $null
$hasMutationMarker = $false
$ownsRequest = $false
$blockedByOperationId = $null

function Get-OmiUpdateBuildId([string]$SourceRoot,[string]$WidgetPath) {
  $artifacts = @('http_server.py','server.py','launcher_transport.py','pyproject.toml','uv.lock','public_contract_snapshot.json','tw_market_dashboard_contract_snapshot.json')
  $hashes = @(foreach ($relative in $artifacts) { (Get-FileHash -LiteralPath (Join-Path $SourceRoot $relative) -Algorithm SHA256).Hash.ToLowerInvariant() })
  $hashes += (Get-FileHash -LiteralPath $WidgetPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes(($hashes -join ''))))).Replace('-','').ToLowerInvariant().Substring(0,16) }
  finally { $hash.Dispose() }
}
function Get-OmiUpdateObservation {
  $status = Invoke-ComponentUpdateProcess -Executable $powershell -Arguments ('-NoProfile -ExecutionPolicy Bypass -File "'+(Join-Path $PSScriptRoot 'runtime-control.ps1')+'" -Action Status') -WorkingDirectory $root -Json
  $health = Invoke-RestMethod -UseBasicParsing -Uri 'http://127.0.0.1:18797/health' -TimeoutSec 5
  if ($status.ok -ne $true -or $status.after.status -ne 'Ready' -or $status.after.server.ownership -ne 'OwnedReady' -or
      $status.after.tunnel.ownership -ne 'OwnedReady' -or $health.ok -ne $true -or $health.service -ne 'omi-search-http-mcp' -or
      [string]$health.buildId -cnotmatch '^[0-9a-f]{16}$') { throw 'LOADED_IDENTITY_NOT_ACCEPTED' }
  return $health
}
function Get-OmiUpdateLoadedResult($Pin) {
  $health=Get-OmiUpdateObservation
  if ([string]$health.buildId -cne [string]$Pin.expectedBuildId) { throw 'LOADED_IDENTITY_NOT_ACCEPTED' }
  return [ordered]@{ phase='ACCEPTED';code='UPDATE_ACCEPTED';operationId=$RequestId.Replace('-','');selectedVersion=$VersionId;
    blockedByOperationId=$null;observedVersion=[string]$health.version;preparedBuildId=[string]$Pin.expectedBuildId;observedBuildId=[string]$health.buildId;ready=$true }
}
function Copy-OmiUpdateSource([string]$Destination) {
  foreach ($relative in @($descriptor.sourcePaths)) {
    $source = Join-Path $root $relative
    $target = Join-Path $Destination $relative
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $target))
    Copy-Item -LiteralPath $source -Destination $target -Recurse -ErrorAction Stop
  }
}
function Assert-OmiUpdateRequest($Request) {
  if ($Request.componentId -cne 'omi_search' -or $Request.requestId -cne $RequestId -or
      $Request.versionId -cne $VersionId -or $Request.expectedSourceDigest -cne $ExpectedSourceDigest) { throw 'REQUEST_CONFLICT' }
}
function Save-OmiUpdateResult($Result) {
  Write-ComponentUpdateJson -Path (Join-Path $operationRoot 'result.json') -Value $Result
  return $Result
}
function Get-OmiUpdaterIdentity {
  $process = [Diagnostics.Process]::GetCurrentProcess()
  try { return @{processId=$process.Id;startTimeUtcTicks=$process.StartTime.ToUniversalTime().Ticks.ToString();executable=$process.MainModule.FileName} }
  finally { $process.Dispose() }
}
function Assert-OmiOriginalUpdaterExited($Request) {
  if (-not $Request.PSObject.Properties['updater'] -or -not $Request.updater -or
      [int]$Request.updater.processId -le 0 -or [string]$Request.updater.startTimeUtcTicks -cnotmatch '^[0-9]+$' -or
      -not [IO.Path]::IsPathRooted([string]$Request.updater.executable)) { throw 'RECOVERY_OWNER_IDENTITY_MISSING' }
  $process = $null
  try {
    try { $process = [Diagnostics.Process]::GetProcessById([int]$Request.updater.processId) }
    catch [ArgumentException] { return }
    catch { throw 'ORIGINAL_UPDATE_OWNER_IDENTITY_UNAVAILABLE' }
    try { $observedStart = $process.StartTime.ToUniversalTime().Ticks.ToString() }
    catch { throw 'ORIGINAL_UPDATE_OWNER_IDENTITY_UNAVAILABLE' }
    if ($observedStart -cne [string]$Request.updater.startTimeUtcTicks) { return }
    # A retained same creation identity is still the original updater. Neither
    # an available mutex nor a timeout authorizes replacing a live process.
    throw 'ORIGINAL_UPDATE_OWNER_STILL_ACTIVE'
  } finally { if ($process) { $process.Dispose() } }
}
function Complete-OmiNotApplied([bool]$Restored) {
  $result = [ordered]@{phase='REJECTED';code='UPDATE_NOT_APPLIED';operationId=$RequestId.Replace('-','');blockedByOperationId=$null;
    selectedVersion=$null;observedVersion=$null;preparedBuildId=$null;observedBuildId=$null;ready=$null;restoredOriginalWidget=$Restored}
  return Save-OmiUpdateResult $result
}
function Restore-OmiUnloadedWidget($Pin) {
  if ($Pin.sourceDigest -cne $ExpectedSourceDigest -or $Pin.versionId -cne $VersionId -or $Pin.requestId -cne $RequestId -or
      [string]$Pin.widgetSha256 -cnotmatch '^[0-9a-f]{64}$' -or
      ($null -ne $Pin.previousWidgetSha256 -and [string]$Pin.previousWidgetSha256 -cnotmatch '^[0-9a-f]{64}$')) { throw 'CANDIDATE_CONTENT_CHANGED' }
  $target = Join-Path $root 'ui\tw-market-dashboard\dist\index.html'
  $backup = Join-Path $operationRoot 'rollback-index.html'
  Assert-ComponentUpdatePath $target
  Assert-ComponentUpdatePath $backup
  $current = if (Test-Path -LiteralPath $target) { (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
  if ($current -ceq $Pin.previousWidgetSha256) { return $false }
  if ($current -cne $Pin.widgetSha256) { throw 'RECOVERY_OUTPUT_IDENTITY_MISMATCH' }
  if ($null -eq $Pin.previousWidgetSha256) {
    # The previous state had no widget; retain this exact published candidate
    # inside its operation instead of deleting it or touching other artifacts.
    [IO.File]::Move($target,(Join-Path $operationRoot ('unloaded-candidate-'+[guid]::NewGuid().ToString('N')+'.html')))
    return $true
  }
  if (-not (Test-Path -LiteralPath $backup) -or (Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Pin.previousWidgetSha256) { throw 'RECOVERY_BACKUP_IDENTITY_MISMATCH' }
  $restore = Join-Path $operationRoot ('restore-'+[guid]::NewGuid().ToString('N')+'.html')
  [IO.File]::Copy($backup,$restore,$false)
  if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Pin.widgetSha256) { throw 'RECOVERY_OUTPUT_IDENTITY_MISMATCH' }
  [IO.File]::Replace($restore,$target,(Join-Path $operationRoot ('replaced-candidate-'+[guid]::NewGuid().ToString('N')+'.html')))
  if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Pin.previousWidgetSha256) { throw 'RECOVERY_OUTPUT_IDENTITY_MISMATCH' }
  return $true
}

try {
  if ($descriptor.schemaVersion -ne 1 -or $descriptor.componentId -cne 'omi_search' -or $descriptor.owner -cne 'component_controller') { throw 'UPDATE_DESCRIPTOR_INVALID' }
  if ($Action -eq 'Preview') {
    [pscustomobject]@{ supported=$true;sourceDigest=(Get-ComponentUpdateSourceDigest -Root $root -Paths @($descriptor.sourcePaths));code='SOURCE_OBSERVED' } | ConvertTo-Json -Compress
    exit 0
  }
  $parsedId = [guid]::Empty
  if (-not [guid]::TryParseExact($RequestId,'D',[ref]$parsedId) -or $VersionId -cnotmatch '^[a-z0-9][a-z0-9_-]{0,47}$' -or
      $ExpectedSourceDigest -cnotmatch '^[0-9a-f]{64}$') { throw 'UPDATE_INPUT_INVALID' }
  $RequestId = $parsedId.ToString('D')
  $operationRoot = Join-Path $root ('.local\source-updates\'+$RequestId)
  Assert-ComponentUpdatePath $operationRoot
  $mutex = New-Object Threading.Mutex($false,'Local\OmiSearchSourceUpdate')
  try { $acquired = $mutex.WaitOne(0,$false) } catch [Threading.AbandonedMutexException] { $acquired=$true }
  if (-not $acquired) { throw 'UPDATE_BUSY' }
  $requestPath = Join-Path $operationRoot 'request.json'
  $resultPath = Join-Path $operationRoot 'result.json'
  $pinPath = Join-Path $operationRoot 'candidate.json'
  $mutationPath = Join-Path $operationRoot 'publication-started.json'
  $reloadPath = Join-Path $operationRoot 'reload-dispatched.json'
  $childJournalRoot = Join-Path $operationRoot 'children'
  if (Test-Path -LiteralPath $requestPath) {
    $originalRequest = Read-ComponentUpdateJson $requestPath
    Assert-OmiUpdateRequest $originalRequest
    $ownsRequest = $true
    if (Test-Path -LiteralPath $resultPath) { Read-ComponentUpdateJson $resultPath | ConvertTo-Json -Compress; exit 0 }
    $hasMutationMarker = Test-Path -LiteralPath $mutationPath
    if ($Action -ne 'Recover') { throw 'RECOVERY_REQUIRED' }
    Assert-OmiOriginalUpdaterExited $originalRequest
    Assert-ComponentUpdateChildrenStopped -Root $childJournalRoot
    if (-not (Test-Path -LiteralPath $reloadPath)) {
      if (-not $hasMutationMarker) { Complete-OmiNotApplied $false | ConvertTo-Json -Compress; exit 0 }
      if (-not (Test-Path -LiteralPath $pinPath)) { throw 'CANDIDATE_CONTENT_CHANGED' }
      $restored = Restore-OmiUnloadedWidget (Read-ComponentUpdateJson $pinPath)
      Complete-OmiNotApplied $restored | ConvertTo-Json -Compress
      exit 0
    }
    if (-not (Test-Path -LiteralPath $pinPath)) { throw 'CANDIDATE_CONTENT_CHANGED' }
    $pin = Read-ComponentUpdateJson $pinPath
    if ($pin.sourceDigest -cne $ExpectedSourceDigest -or $pin.versionId -cne $VersionId -or $pin.requestId -cne $RequestId) { throw 'CANDIDATE_CONTENT_CHANGED' }
    $reloadPin = Read-ComponentUpdateJson $reloadPath
    if ($reloadPin.requestId -cne $RequestId -or $reloadPin.expectedBuildId -cne $pin.expectedBuildId) { throw 'CANDIDATE_CONTENT_CHANGED' }
    $preparedWidget = Join-Path $operationRoot 'stage\index.html'
    if ((Get-FileHash -LiteralPath $preparedWidget -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin.widgetSha256) { throw 'CANDIDATE_CONTENT_CHANGED' }
    if ((Get-OmiUpdateBuildId -SourceRoot (Join-Path $operationRoot 'source') -WidgetPath $preparedWidget) -cne $pin.expectedBuildId) { throw 'CANDIDATE_CONTENT_CHANGED' }
    # Recovery observes the original dispatch and its retained artifacts. New
    # editable source belongs to a later request, not this boot-loaded identity.
    # It never rebuilds, republishes or reloads.
    $observed=Get-OmiUpdateObservation
    if ([string]$observed.buildId -cne $pin.expectedBuildId) {
      if (-not $pin.PSObject.Properties['previousIdentity'] -or -not $pin.previousIdentity -or
          $observed.buildId -cne $pin.previousIdentity.buildId -or $observed.version -cne $pin.previousIdentity.version) { throw 'LOADED_IDENTITY_NOT_ACCEPTED' }
      $target=Join-Path $root 'ui\tw-market-dashboard\dist\index.html'
      $oldWidget=Join-Path $operationRoot 'rollback-index.html'
      $currentSha=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($currentSha -ceq $pin.previousWidgetSha256) { $oldWidget=$target }
      # Python source is not rolled back by this widget owner. Only close the
      # old-runtime case when the unchanged source plus original widget proves
      # that same old build is still reproducible. Otherwise retain uncertainty.
      if (-not (Test-Path -LiteralPath $oldWidget) -or (Get-OmiUpdateBuildId -SourceRoot $root -WidgetPath $oldWidget) -cne $observed.buildId) { throw 'OLD_LOADED_SOURCE_UNVERIFIED' }
      $restored=Restore-OmiUnloadedWidget $pin
      $again=Get-OmiUpdateObservation
      if ($again.buildId -cne $observed.buildId -or $again.version -cne $observed.version) { throw 'LOADED_IDENTITY_NOT_ACCEPTED' }
      Save-OmiUpdateResult ([ordered]@{phase='REJECTED';code='UPDATE_ROLLED_BACK';operationId=$RequestId.Replace('-','');blockedByOperationId=$null;
        selectedVersion=$null;observedVersion=$again.version;preparedBuildId=$pin.expectedBuildId;observedBuildId=$again.buildId;ready=$true;restoredOriginalWidget=$restored}) | ConvertTo-Json -Compress
      exit 0
    }
    if ((Get-FileHash -LiteralPath (Join-Path $root 'ui\tw-market-dashboard\dist\index.html') -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin.widgetSha256) { throw 'CANDIDATE_CONTENT_CHANGED' }
    Save-OmiUpdateResult (Get-OmiUpdateLoadedResult $pin) | ConvertTo-Json -Compress
    exit 0
  }
  if ($Action -eq 'Recover') { throw 'ORIGINAL_OPERATION_NOT_FOUND' }
  $operationsRoot = Join-Path $root '.local\source-updates'
  if (Test-Path -LiteralPath $operationsRoot) {
    $operations = @(Get-ChildItem -LiteralPath $operationsRoot -Directory)
    # Retained operation directories are the request/replay index. Completed
    # history and rollback pins do not consume active admission capacity.
    foreach ($operation in $operations) {
      Assert-ComponentUpdatePath $operation.FullName
      if ((Test-Path -LiteralPath (Join-Path $operation.FullName 'request.json')) -and -not (Test-Path -LiteralPath (Join-Path $operation.FullName 'result.json'))) {
        $blockedByOperationId = ([guid]$operation.Name).ToString('N')
        throw 'UPDATE_RECOVERY_REQUIRED_USE_ORIGINAL_REQUEST'
      }
    }
  }
  $digest = Get-ComponentUpdateSourceDigest -Root $root -Paths @($descriptor.sourcePaths)
  if ($digest -cne $ExpectedSourceDigest) { throw 'SOURCE_CONTENT_CHANGED' }
  $request = [ordered]@{ schemaVersion=1;componentId='omi_search';requestId=$RequestId;versionId=$VersionId;expectedSourceDigest=$digest;createdAt=[DateTimeOffset]::UtcNow.ToString('o');updater=(Get-OmiUpdaterIdentity) }
  $versionPath = Join-Path $root ('.local\source-update-versions\'+$VersionId+'.json')
  if (Test-Path -LiteralPath $versionPath) {
    $version = Read-ComponentUpdateJson $versionPath
    if ($version.expectedSourceDigest -cne $digest) { throw 'VERSION_CONTENT_CHANGED_USE_NEW_ID' }
    if ($version.requestId -cne $RequestId) { throw 'VERSION_BOUND_TO_ORIGINAL_REQUEST' }
  } else { Write-ComponentUpdateJson -Path $versionPath -Value $request }
  Write-ComponentUpdateJson -Path $requestPath -Value $request
  $ownsRequest = $true
  # Discovery can return multiple PATH installations; FileName must be one path.
  $uv = Get-Command uv.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $uv -or -not $node) { throw 'BUILD_TOOL_NOT_FOUND' }
  # --check never syncs or mutates the running environment. Dependency changes
  # need an independently prepared compatible environment before this update.
  try { Invoke-ComponentUpdateProcess -Executable $uv.Source -Arguments 'sync --frozen --check --offline' -WorkingDirectory $root -ChildJournalRoot $childJournalRoot | Out-Null }
  catch { if ([string]$_.Exception.Message -ceq 'UPDATE_CHILD_FAILED') { throw 'DEPENDENCY_PREPARATION_REQUIRED' }; throw }
  $snapshotRoot = Join-Path $operationRoot 'source'
  Copy-OmiUpdateSource $snapshotRoot
  if ((Get-ComponentUpdateSourceDigest -Root $snapshotRoot -Paths @($descriptor.sourcePaths)) -cne $ExpectedSourceDigest) { throw 'SOURCE_CAPTURE_CHANGED' }
  if ((Get-ComponentUpdateSourceDigest -Root $root -Paths @($descriptor.sourcePaths)) -cne $ExpectedSourceDigest) { throw 'SOURCE_CONTENT_CHANGED' }
  $stageRoot = Join-Path $operationRoot 'stage'
  $widgetRoot = Join-Path $root 'ui\tw-market-dashboard'
  $buildArgs = '"'+(Join-Path $widgetRoot 'scripts\build.mjs')+'" --source-dir "'+(Join-Path $snapshotRoot 'ui\tw-market-dashboard')+'" --output-dir "'+$stageRoot+'"'
  Invoke-ComponentUpdateProcess -Executable $node.Source -Arguments $buildArgs -WorkingDirectory $widgetRoot -ChildJournalRoot $childJournalRoot | Out-Null
  $stageWidget = Join-Path $stageRoot 'index.html'
  $targetWidget = Join-Path $widgetRoot 'dist\index.html'
  if ((Get-ComponentUpdateSourceDigest -Root $root -Paths @($descriptor.sourcePaths)) -cne $ExpectedSourceDigest) { throw 'SOURCE_CONTENT_CHANGED' }
  $widgetSha = (Get-FileHash -LiteralPath $stageWidget -Algorithm SHA256).Hash.ToLowerInvariant()
  $priorSha = if (Test-Path -LiteralPath $targetWidget) { (Get-FileHash -LiteralPath $targetWidget -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
  $previousIdentity=$null
  try { $prior=Get-OmiUpdateObservation; $previousIdentity=@{buildId=$prior.buildId;version=$prior.version} } catch { }
  $pin = [ordered]@{ previousIdentity=$previousIdentity;sourceDigest=$digest;widgetSha256=$widgetSha;previousWidgetSha256=$priorSha;
    expectedBuildId=(Get-OmiUpdateBuildId -SourceRoot $snapshotRoot -WidgetPath $stageWidget);versionId=$VersionId;requestId=$RequestId }
  Write-ComponentUpdateJson -Path $pinPath -Value $pin
  Write-ComponentUpdateJson -Path $mutationPath -Value @{requestId=$RequestId;createdAt=[DateTimeOffset]::UtcNow.ToString('o')}
  $hasMutationMarker = $true
  Assert-ComponentUpdatePath $targetWidget
  [void][IO.Directory]::CreateDirectory((Split-Path -Parent $targetWidget))
  $publishPath = Join-Path $operationRoot 'publish.html'
  [IO.File]::Copy($stageWidget,$publishPath,$false)
  if ($null -ne $priorSha) {
    if ((Get-FileHash -LiteralPath $targetWidget -Algorithm SHA256).Hash.ToLowerInvariant() -cne $priorSha) { throw 'OUTPUT_CONCURRENT_CHANGE' }
    [IO.File]::Replace($publishPath,$targetWidget,(Join-Path $operationRoot 'rollback-index.html'))
  } else { [IO.File]::Move($publishPath,$targetWidget) }
  if ((Get-ComponentUpdateSourceDigest -Root $root -Paths @($descriptor.sourcePaths)) -cne $ExpectedSourceDigest) { throw 'SOURCE_CONTENT_CHANGED' }
  Write-ComponentUpdateJson -Path $reloadPath -Value @{requestId=$RequestId;expectedBuildId=$pin.expectedBuildId;createdAt=[DateTimeOffset]::UtcNow.ToString('o')}
  $reload = Invoke-ComponentUpdateProcess -Executable $powershell -Arguments ('-NoProfile -ExecutionPolicy Bypass -File "'+(Join-Path $PSScriptRoot 'runtime-control.ps1')+'" -Action ReloadRuntime') -WorkingDirectory $root -TimeoutMs 180000 -Json -Lifecycle
  if ($reload.ok -ne $true) { throw 'LIFECYCLE_RESULT_REJECTED' }
  Save-OmiUpdateResult (Get-OmiUpdateLoadedResult $pin) | ConvertTo-Json -Compress
}
catch {
  $code = [string]$_.Exception.Message
  if ($code -cnotmatch '^[A-Z][A-Z0-9_]{0,95}$') { $code='SOURCE_UPDATE_FAILED' }
  $phase = if ($hasMutationMarker -or ($ownsRequest -and $Action -eq 'Recover') -or $code -in @('RECOVERY_REQUIRED','UPDATE_CHILD_TIMEOUT_CHECK_ORIGINAL_OPERATION','UPDATE_CHILD_OUTPUT_UNCERTAIN','UPDATE_LIFECYCLE_RESULT_UNCERTAIN','UPDATE_RECOVERY_REQUIRED_USE_ORIGINAL_REQUEST','UPDATE_FINITE_CHILD_STOP_UNVERIFIED')) { 'RECOVERY_REQUIRED' } else { 'REJECTED' }
  $result = [ordered]@{phase=$phase;code=$code;operationId=([string]$RequestId).Replace('-','');blockedByOperationId=$blockedByOperationId;selectedVersion=$null;observedVersion=$null;preparedBuildId=$null;observedBuildId=$null;ready=$null}
  if ($code -eq 'DEPENDENCY_PREPARATION_REQUIRED') { $result['nextStep']='Prepare the existing locked OMI Search Python environment with its operator, then use a new immutable version and request after reviewing this rejected receipt.' }
  # Never overwrite historical failures, and do not pin transient recovery
  # observations as a terminal result that would prevent a later read-only check.
  if ($phase -eq 'REJECTED' -and $ownsRequest -and $operationRoot -and (Test-Path -LiteralPath (Join-Path $operationRoot 'request.json')) -and -not (Test-Path -LiteralPath (Join-Path $operationRoot 'result.json'))) {
    try { Write-ComponentUpdateJson -Path (Join-Path $operationRoot 'result.json') -Value $result } catch { }
  }
  if ($ownsRequest -and $operationRoot) {
    try { Write-ComponentUpdateJson -Path (Join-Path $operationRoot ('failure-'+[guid]::NewGuid().ToString('N')+'.json')) -Value @{phase=$phase;code=$code;observedAt=[DateTimeOffset]::UtcNow.ToString('o')} } catch { }
  }
  $result | ConvertTo-Json -Compress
  exit 1
}
finally { if ($acquired) { $mutex.ReleaseMutex() }; if ($mutex) { $mutex.Dispose() } }
