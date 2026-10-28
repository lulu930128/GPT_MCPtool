Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'component-update-common.ps1')

function Get-NodeUpdateField($Object, [string]$Name) {
    $property=$Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Test-NodeUpdateIdentity($Expected, $Observed) {
    if ($null -eq $Observed -or -not $Observed.ready) { return $false }
    foreach ($key in @('version', 'buildId', 'contractVersion', 'toolCount')) {
        $left = $Expected.PSObject.Properties[$key]
        $right = $Observed.PSObject.Properties[$key]
        if ($null -eq $left -and $null -eq $right) { continue }
        if ($null -eq $left -or $null -eq $right -or [string]$left.Value -cne [string]$right.Value) { return $false }
    }
    return $true
}

function Get-NodeUpdateProcessIdentity {
    $process=[Diagnostics.Process]::GetCurrentProcess()
    try { return @{pid=$process.Id;startTicks=[string]$process.StartTime.ToUniversalTime().Ticks;executable=$process.MainModule.FileName} }
    finally { $process.Dispose() }
}

function Assert-NodeUpdateProcessExited($Owner) {
    if ($null -eq $Owner -or -not (Get-NodeUpdateField $Owner 'pid') -or -not (Get-NodeUpdateField $Owner 'startTicks') -or -not (Get-NodeUpdateField $Owner 'executable')) { throw 'UPDATE_UPDATER_IDENTITY_MISSING' }
    try { $process=[Diagnostics.Process]::GetProcessById([int]$Owner.pid) }
    catch [ArgumentException] { return }
    catch { throw 'UPDATE_UPDATER_IDENTITY_UNVERIFIED' }
    try {
        if ($process.HasExited) { return }
        if ([string]$process.StartTime.ToUniversalTime().Ticks -cne [string]$Owner.startTicks) { return }
        if ($process.MainModule.FileName -ine [string]$Owner.executable) { throw 'UPDATE_UPDATER_IDENTITY_UNVERIFIED' }
        throw 'UPDATE_ORIGINAL_UPDATER_ACTIVE'
    } finally { $process.Dispose() }
}

# These pins cover the complete published tree, including files outside the
# component's public buildId calculation. Recovery never replaces an unpinned tree.
function Get-NodeUpdateArtifactPin([string]$Root) {
    Assert-ComponentUpdatePath $Root
    if (-not (Test-Path -LiteralPath $Root)) { return @{exists=$false;digest=$null} }
    if (-not (Get-Item -LiteralPath $Root -Force).PSIsContainer) { throw 'UPDATE_ARTIFACT_PATH_REJECTED' }
    $Root=[IO.Path]::GetFullPath($Root).TrimEnd('\')
    $rows=New-Object 'Collections.Generic.SortedDictionary[string,string]' ([StringComparer]::Ordinal)
    $pending=New-Object 'Collections.Generic.Stack[string]'; $pending.Push($Root)
    while ($pending.Count) {
        $item=Get-Item -LiteralPath $pending.Pop() -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'UPDATE_REPARSE_REJECTED' }
        $name=if($item.FullName.Length -eq $Root.Length){'.'}else{$item.FullName.Substring($Root.Length+1).Replace('\','/')}
        if ($name -match '(^|/)(\.env[^/]*|\.secrets|\.git|node_modules)(/|$)' -or $name -match '\.(dpapi|pem|key|pfx|p12|db|sqlite[0-9]*)$') { throw 'UPDATE_PRIVATE_ARTIFACT_REJECTED' }
        if ($rows.Count -ge 20000) { throw 'UPDATE_ARTIFACT_LIMIT' }
        if ($item.PSIsContainer) {
            $rows[$name]='directory'
            foreach ($child in Get-ChildItem -LiteralPath $item.FullName -Force) { $pending.Push($child.FullName) }
        } else {
            if ($item.Length -gt 32000000) { throw 'UPDATE_ARTIFACT_LIMIT' }
            $rows[$name]=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    $text=(@(foreach($row in $rows.GetEnumerator()){$row.Key+':'+$row.Value}) -join "`n")
    $hash=[Security.Cryptography.SHA256]::Create()
    try { return @{exists=$true;digest=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-','').ToLowerInvariant()} }
    finally { $hash.Dispose() }
}

function Test-NodeUpdateArtifactPin($Expected,$Actual) {
    return ($null -ne $Expected -and [bool]$Expected.exists -eq [bool]$Actual.exists -and [string]$Expected.digest -ceq [string]$Actual.digest)
}

function Restore-NodeUpdateUnappliedArtifact([string]$ArtifactRoot,[string]$OperationRoot,$Prepared) {
    if ($Prepared.prepareOnly) { return }
    $previous=Get-NodeUpdateField $Prepared 'previousArtifact'
    $candidate=Get-NodeUpdateField $Prepared 'candidateArtifact'
    if ($null -eq $previous -or $null -eq $candidate) { throw 'UPDATE_ARTIFACT_RECOVERY_PIN_MISSING' }
    $current=Get-NodeUpdateArtifactPin $ArtifactRoot
    $backup=Join-Path $OperationRoot 'rollback-dist'
    $backupPin=Get-NodeUpdateArtifactPin $backup
    if ($backupPin.exists -and -not (Test-NodeUpdateArtifactPin $previous $backupPin)) { throw 'UPDATE_ROLLBACK_ARTIFACT_CHANGED' }
    if (Test-NodeUpdateArtifactPin $previous $current) { return }
    if ($current.exists -and -not (Test-NodeUpdateArtifactPin $candidate $current)) { throw 'UPDATE_DIST_CHANGED' }
    if ($previous.exists -and -not (Test-NodeUpdateArtifactPin $previous $backupPin)) { throw 'UPDATE_ROLLBACK_ARTIFACT_MISSING' }

    # Preserve the original backup and the unadopted candidate. A crash during
    # this recovery leaves only pinned trees; the next original-ID recovery can
    # resume without overwriting any backup or issuing ReloadRuntime.
    $restoreStage=$null
    if ($previous.exists) {
        $restoreStage=Join-Path $OperationRoot ('restore-dist-'+[guid]::NewGuid().ToString('N'))
        Copy-Item -LiteralPath $backup -Destination $restoreStage -Recurse -ErrorAction Stop
        if (-not (Test-NodeUpdateArtifactPin $previous (Get-NodeUpdateArtifactPin $restoreStage))) { throw 'UPDATE_ROLLBACK_COPY_UNVERIFIED' }
    }
    if ($current.exists) {
        $unapplied=Join-Path $OperationRoot 'unapplied-dist'
        Assert-ComponentUpdatePath $unapplied
        if (Test-Path -LiteralPath $unapplied) { throw 'UPDATE_UNAPPLIED_ARTIFACT_ALREADY_PRESENT' }
        Move-Item -LiteralPath $ArtifactRoot -Destination $unapplied -ErrorAction Stop
    }
    if ($previous.exists) {
        [void][IO.Directory]::CreateDirectory((Split-Path -Parent $ArtifactRoot))
        Move-Item -LiteralPath $restoreStage -Destination $ArtifactRoot -ErrorAction Stop
    }
    if (-not (Test-NodeUpdateArtifactPin $previous (Get-NodeUpdateArtifactPin $ArtifactRoot))) { throw 'UPDATE_ROLLBACK_RESTORE_UNVERIFIED' }
}

# A mechanical transaction for source/dist adapters. Build, health identity and
# lifecycle authority remain callbacks owned by the component's fixed wrapper.
function Invoke-NodeSourceUpdate {
    param(
        [Parameter(Mandatory=$true)][string]$ComponentRoot,
        [Parameter(Mandatory=$true)][string]$ComponentId,
        [Parameter(Mandatory=$true)][string[]]$SourcePaths,
        [ValidateSet('Preview','Update','Recover')][string]$Action='Preview',
        [string]$RequestId, [string]$VersionId, [string]$ExpectedSourceDigest,
        [string]$ArtifactRelative='dist', [switch]$PrepareOnly,
        [scriptblock]$Preflight={ [pscustomobject]@{allowed=$false;code='UPDATE_PREFLIGHT_REQUIRED'} },
        [Parameter(Mandatory=$true)][scriptblock]$Build,
        [Parameter(Mandatory=$true)][scriptblock]$Identity,
        [Parameter(Mandatory=$true)][scriptblock]$Reload,
        [Parameter(Mandatory=$true)][scriptblock]$Observe
    )
    $result = [ordered]@{ schemaVersion=1; componentId=$ComponentId; supported=$true; action='update_from_source'; phase='REJECTED'; code='UPDATE_FAILED'; ready=$false }
    $operationRoot=$null; $acquired=$false; $mutex=$null; $prepared=$null; $mutating=$false; $ownsNewOperation=$false
    try {
        $ComponentRoot=[IO.Path]::GetFullPath($ComponentRoot).TrimEnd('\')
        Assert-ComponentUpdatePath $ComponentRoot
        if ($ComponentId -cnotmatch '^[a-z][a-z0-9_]{0,47}$') { throw 'UPDATE_COMPONENT_INVALID' }
        if ($ArtifactRelative -cnotmatch '^[A-Za-z0-9_][A-Za-z0-9_/-]*$' -or $ArtifactRelative -match '(^|/)\.\.(/|$)') { throw 'UPDATE_ARTIFACT_PATH_REJECTED' }
        $artifactRoot=Join-Path $ComponentRoot $ArtifactRelative
        Assert-ComponentUpdatePath $artifactRoot
        if (-not [IO.Path]::GetFullPath($artifactRoot).StartsWith($ComponentRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'UPDATE_ARTIFACT_PATH_REJECTED' }
        if ($Action -eq 'Preview') {
            $result.sourceDigest=Get-ComponentUpdateSourceDigest -Root $ComponentRoot -Paths $SourcePaths
            $result.phase='PREVIEW'; $result.code='SOURCE_OBSERVED'; return [pscustomobject]$result
        }
        $requestGuid=[guid]::Empty
        if (-not [guid]::TryParseExact($RequestId,'D',[ref]$requestGuid)) { throw 'UPDATE_REQUEST_ID_INVALID' }
        $RequestId=$requestGuid.ToString('D')
        if ($VersionId -cnotmatch '^[a-z0-9][a-z0-9._-]{0,47}$') { throw 'UPDATE_VERSION_INVALID' }
        if ($ExpectedSourceDigest -cnotmatch '^[a-f0-9]{64}$') { throw 'UPDATE_SOURCE_DIGEST_INVALID' }
        $result.requestId=$RequestId; $result.operationId=$requestGuid.ToString('N'); $result.requestedVersion=$VersionId
        $operationRoot=Join-Path $ComponentRoot ('.local\source-updates\'+$RequestId)
        Assert-ComponentUpdatePath $operationRoot
        $intentPath=Join-Path $operationRoot 'intent.json'
        $preparedPath=Join-Path $operationRoot 'prepared.json'
        $terminalPath=Join-Path $operationRoot 'terminal.json'
        $mutex=New-Object Threading.Mutex($false, ('Local\McpSourceUpdate.'+$ComponentId))
        try { $acquired=$mutex.WaitOne(0,$false) } catch [Threading.AbandonedMutexException] { $acquired=$true }
        if (-not $acquired) { throw 'UPDATE_ACTION_BUSY' }
        if (Test-Path -LiteralPath $intentPath) {
            $intent=Read-ComponentUpdateJson $intentPath
            if ($intent.componentId -cne $ComponentId -or $intent.requestId -cne $RequestId -or $intent.versionId -cne $VersionId -or $intent.sourceDigest -cne $ExpectedSourceDigest) { throw 'UPDATE_REQUEST_CONFLICT' }
            if ((Get-NodeUpdateField $intent 'artifactRelative') -cne $ArtifactRelative -or [bool](Get-NodeUpdateField $intent 'prepareOnly') -ne [bool]$PrepareOnly) { throw 'UPDATE_REQUEST_CONFLICT' }
            if (Test-Path -LiteralPath $terminalPath) { return Read-ComponentUpdateJson $terminalPath }
            $result.phase='RECOVERY_REQUIRED'
            $reloadRecorded=Test-Path -LiteralPath (Join-Path $operationRoot 'reload-requested.json')
            if (-not $reloadRecorded) {
                Assert-NodeUpdateProcessExited (Get-NodeUpdateField $intent 'updater')
                if ((Get-NodeUpdateField $intent 'trackedBuild') -ne $true) { throw 'UPDATE_FINITE_CHILD_TRACKING_MISSING' }
                Assert-ComponentUpdateChildrenStopped -Root (Join-Path $operationRoot 'children')
                if (Test-Path -LiteralPath $preparedPath) {
                    $prepared=Read-ComponentUpdateJson $preparedPath
                    Restore-NodeUpdateUnappliedArtifact -ArtifactRoot $artifactRoot -OperationRoot $operationRoot -Prepared $prepared
                    $result.expectedIdentity=$prepared.expectedIdentity; $result.preparedBuildId=$prepared.expectedIdentity.buildId; $result.rollback=$prepared.rollback
                }
                $result.phase='REJECTED'; $result.code='UPDATE_NOT_APPLIED'; $result.sourceDigest=$intent.sourceDigest
                Write-ComponentUpdateJson -Path $terminalPath -Value $result
                return [pscustomobject]$result
            }
            # Once Reload may have been delivered, recovery only observes the
            # original candidate and loaded owner. It never repeats dispatch.
            if (-not (Test-Path -LiteralPath $preparedPath)) { throw 'UPDATE_PREPARATION_INCOMPLETE' }
            $prepared=Read-ComponentUpdateJson $preparedPath
            # Mutable source may have advanced since dispatch. The original
            # published artifact pin and boot-loaded identity prove this receipt;
            # only a new Update needs a fresh source digest.
            $result.sourceDigest=$intent.sourceDigest
            if (-not $PrepareOnly -and -not (Test-NodeUpdateArtifactPin (Get-NodeUpdateField $prepared 'candidateArtifact') (Get-NodeUpdateArtifactPin $artifactRoot))) { throw 'UPDATE_DIST_CHANGED' }
            $observed=& $Observe
            if (-not (Test-NodeUpdateIdentity $prepared.expectedIdentity $observed)) { throw 'UPDATE_LOADED_IDENTITY_UNVERIFIED' }
            $result.phase='ACCEPTED'; $result.code='UPDATE_RECOVERED'; $result.ready=$true
            $result.selectedVersion=$VersionId
            $result.observedBuildId=$observed.buildId; $result.observedVersion=$observed.version
            $result.expectedIdentity=$prepared.expectedIdentity; $result.observedIdentity=$observed
            $result.preparedBuildId=$prepared.expectedIdentity.buildId
            $result.rollback=$prepared.rollback
            Write-ComponentUpdateJson -Path $terminalPath -Value $result
            return [pscustomobject]$result
        }
        if ($Action -eq 'Recover') { throw 'UPDATE_OPERATION_NOT_FOUND' }
        $sourceDigest=Get-ComponentUpdateSourceDigest -Root $ComponentRoot -Paths $SourcePaths
        $result.sourceDigest=$sourceDigest
        if ($sourceDigest -cne $ExpectedSourceDigest) { throw 'UPDATE_SOURCE_CHANGED_USE_NEW_VERSION' }
        $operationsParent=Split-Path -Parent $operationRoot
        if (Test-Path -LiteralPath $operationsParent) {
            foreach ($prior in Get-ChildItem -LiteralPath $operationsParent -Directory) {
                if ($prior.Name -match '^[a-f0-9-]{36}$' -and (Test-Path -LiteralPath (Join-Path $prior.FullName 'intent.json')) -and -not (Test-Path -LiteralPath (Join-Path $prior.FullName 'terminal.json'))) { throw 'UPDATE_PRIOR_OPERATION_RECOVERY_REQUIRED' }
            }
        }
        $versionPath=Join-Path $ComponentRoot ('.local\source-updates\versions\'+$VersionId+'.json')
        if (Test-Path -LiteralPath $versionPath) { throw 'UPDATE_VERSION_ALREADY_RESERVED_USE_NEW_ID' }
        Write-ComponentUpdateJson -Path $intentPath -Value @{ schemaVersion=1; requestId=$RequestId; componentId=$ComponentId; versionId=$VersionId; sourceDigest=$sourceDigest; artifactRelative=$ArtifactRelative; prepareOnly=[bool]$PrepareOnly; updater=(Get-NodeUpdateProcessIdentity); trackedBuild=$true; createdAt=[DateTime]::UtcNow.ToString('o') }
        $ownsNewOperation=$true
        Write-ComponentUpdateJson -Path $versionPath -Value @{ requestId=$RequestId; sourceDigest=$sourceDigest; versionId=$VersionId }
        $stageDist=Join-Path $operationRoot 'stage\dist'
        if (-not $PrepareOnly) { [void][IO.Directory]::CreateDirectory($stageDist) }
        & $Build $stageDist (Join-Path $operationRoot 'children') | Out-Null
        Assert-ComponentUpdateChildrenStopped -Root (Join-Path $operationRoot 'children')
        if ((Get-ComponentUpdateSourceDigest -Root $ComponentRoot -Paths $SourcePaths) -cne $sourceDigest) { throw 'UPDATE_SOURCE_CHANGED_DURING_BUILD' }
        $expected=& $Identity $stageDist
        if ($expected.buildId -cnotmatch '^[a-f0-9]{16,64}$' -or [string]::IsNullOrWhiteSpace([string]$expected.version)) { throw 'UPDATE_BUILD_IDENTITY_INVALID' }
        $preflightResult=& $Preflight
        if ($null -eq $preflightResult -or -not $preflightResult.allowed) {
            $gateCode=if($null -ne $preflightResult -and $preflightResult.PSObject.Properties['code']){[string]$preflightResult.code}else{'UPDATE_OWNER_PREFLIGHT_REJECTED'}
            throw $gateCode
        }
        $dist=$artifactRoot
        $backup=Join-Path $operationRoot 'rollback-dist'
        $promote=Join-Path $operationRoot 'promote-dist'
        foreach ($path in @($dist,$backup,$promote,$stageDist)) {
            Assert-ComponentUpdatePath $path
            if (-not [IO.Path]::GetFullPath($path).StartsWith($ComponentRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'UPDATE_PROMOTION_PATH_REJECTED' }
        }
        if (-not $PrepareOnly) { Copy-Item -LiteralPath $stageDist -Destination $promote -Recurse -ErrorAction Stop }
        $prepared=@{ expectedIdentity=$expected; artifactRelative=$ArtifactRelative; prepareOnly=[bool]$PrepareOnly; rollback=@{ artifactRoot=$(if($PrepareOnly){$null}else{$backup}); automatic=$false }; sourceDigest=$sourceDigest; createdAt=[DateTime]::UtcNow.ToString('o') }
        if (-not $PrepareOnly) {
            $prepared.previousArtifact=Get-NodeUpdateArtifactPin $dist
            $prepared.candidateArtifact=Get-NodeUpdateArtifactPin $stageDist
            if (-not (Test-NodeUpdateArtifactPin $prepared.candidateArtifact (Get-NodeUpdateArtifactPin $promote))) { throw 'UPDATE_PROMOTION_COPY_UNVERIFIED' }
        }
        Write-ComponentUpdateJson -Path $preparedPath -Value $prepared
        $mutating=$true
        if (-not $PrepareOnly) {
            if (Test-Path -LiteralPath $dist) { Move-Item -LiteralPath $dist -Destination $backup -ErrorAction Stop }
            [void][IO.Directory]::CreateDirectory((Split-Path -Parent $dist))
            Move-Item -LiteralPath $promote -Destination $dist -ErrorAction Stop
            $result.selectedVersion=$VersionId
            Write-ComponentUpdateJson -Path (Join-Path $operationRoot 'promoted.json') -Value @{ at=[DateTime]::UtcNow.ToString('o'); expectedIdentity=$expected }
        }
        Write-ComponentUpdateJson -Path (Join-Path $operationRoot 'reload-requested.json') -Value @{ at=[DateTime]::UtcNow.ToString('o'); requestId=$RequestId }
        & $Reload | Out-Null
        $observed=& $Observe
        if (-not (Test-NodeUpdateIdentity $expected $observed)) { throw 'UPDATE_LOADED_IDENTITY_UNVERIFIED' }
        $result.phase='ACCEPTED'; $result.code='UPDATE_ACCEPTED'; $result.ready=$true
        $result.selectedVersion=$VersionId
        $result.observedBuildId=$observed.buildId; $result.observedVersion=$observed.version
        $result.expectedIdentity=$expected; $result.observedIdentity=$observed; $result.rollback=$prepared.rollback
        $result.preparedBuildId=$expected.buildId
        Write-ComponentUpdateJson -Path $terminalPath -Value $result
        return [pscustomobject]$result
    } catch {
        $code=[string]$_.Exception.Message
        $result.code=if($code -cmatch '^[A-Z][A-Z0-9_]{0,95}$'){$code}else{'UPDATE_FAILED'}
        if ($mutating -or $result.phase -eq 'RECOVERY_REQUIRED' -or $result.code -match 'TIMEOUT|UNCERTAIN|FINITE_CHILD_STOP_UNVERIFIED') { $result.phase='RECOVERY_REQUIRED' }
        if ($ownsNewOperation -and $result.phase -eq 'REJECTED') {
            # An owned wrapper may translate a compiler error. Do not let that
            # hide an unproven child scope and incorrectly release the operation.
            try { Assert-ComponentUpdateChildrenStopped -Root (Join-Path $operationRoot 'children') }
            catch { $result.failureCode=$result.code; $result.code='UPDATE_FINITE_CHILD_STOP_UNVERIFIED'; $result.phase='RECOVERY_REQUIRED' }
        }
        if ($null -ne $prepared) { $result.expectedIdentity=$prepared.expectedIdentity; $result.preparedBuildId=$prepared.expectedIdentity.buildId; $result.rollback=$prepared.rollback }
        if ($operationRoot -and (Test-Path -LiteralPath (Join-Path $operationRoot 'intent.json')) -and $result.code -ne 'UPDATE_REQUEST_CONFLICT') {
            try { Write-ComponentUpdateJson -Path (Join-Path $operationRoot ('failure-'+[guid]::NewGuid().ToString('N')+'.json')) -Value $result } catch { }
            if ($result.phase -eq 'REJECTED' -and $result.code -ne 'UPDATE_ACTION_BUSY') {
                try { Write-ComponentUpdateJson -Path (Join-Path $operationRoot 'terminal.json') -Value $result } catch { }
            }
        }
        return [pscustomobject]$result
    } finally {
        if($acquired){$mutex.ReleaseMutex()}
        if($null -ne $mutex){$mutex.Dispose()}
    }
}
