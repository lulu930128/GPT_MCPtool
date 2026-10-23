Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
if (-not ('McpCcReloadNative' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'RemoteSelfReload.Native.cs') }
$script:Utf8 = New-Object Text.UTF8Encoding($false, $true)
$script:Contract = 'remote-self-reload-r1'

function Assert-R1Fields($Value, [string[]]$Names) {
    if ($null -eq $Value -or $Value -isnot [pscustomobject]) { throw 'INVALID_MESSAGE' }
    $actual = @($Value.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
    if (($actual -join '|') -cne (($Names | Sort-Object) -join '|')) { throw 'INVALID_MESSAGE' }
}
function Assert-R1String($Value, [string]$Pattern) {
    if ($Value -isnot [string] -or $Value -cnotmatch $Pattern) { throw 'INVALID_MESSAGE' }
}
function Get-R1Digest($Value) { return [McpCcReloadNative]::Digest(($Value | ConvertTo-Json -Depth 20 -Compress)) }
function Assert-R1Clock($Engine) {
    $now=[DateTime]::UtcNow
    if ($now -lt $Engine.lastNow) { $Engine.poisoned=$true; throw 'CLOCK_ROLLBACK' }
    $Engine.lastNow=$now
}
function Get-R1Exact($Receipt) {
    return [ordered]@{ contract=$script:Contract; requestId=$Receipt.requestId; component='codex_bridge'; action='reload_runtime';
        oldPid=$Receipt.oldPid; oldBuildId=$Receipt.oldBuildId; targetBuildId=$Receipt.targetBuildId;
        expiresAt=$Receipt.expiresAt; nonce=$Receipt.nonce }
}
function Save-R1State($Engine) {
    if ($Engine.poisoned) { throw 'STORE_CORRUPT' }
    try {
    $json = $Engine.state | ConvertTo-Json -Depth 25 -Compress
    if ($script:Utf8.GetByteCount($json) -gt 1048576) { throw 'STORE_LIMIT' }
    $path = Join-Path $Engine.root 'receipts.json'; $temp = Join-Path $Engine.root 'receipts.next'
    $stream = New-Object IO.FileStream($temp, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $bytes=$script:Utf8.GetBytes($json); $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    if (Test-Path -LiteralPath $path) { [IO.File]::Replace($temp,$path,[NullString]::Value) } else { [IO.File]::Move($temp,$path) }
    } catch { $Engine.poisoned=$true; throw 'STORE_CORRUPT' }
}
function Set-R1State($Engine, $Receipt, [string]$State, [string]$Code) {
    $Receipt.state=$State; $Receipt.code=$Code; $Receipt.updatedAt=[DateTime]::UtcNow.ToString('o')
    $Receipt.history=@($Receipt.history)+@([pscustomobject]@{state=$State; at=$Receipt.updatedAt; code=$Code})
    Save-R1State $Engine
}
function New-R1Engine {
    param([string]$Root, $Policy, [scriptblock]$Snapshot, [scriptblock]$Execute, [scriptblock]$Postcheck)
    # Production callers must establish directory ACL/owner/job-tree identity before constructing this engine.
    $state=[pscustomobject]@{contract=$script:Contract; receipts=@()}
    $path=Join-Path $Root 'receipts.json'
    if (Test-Path -LiteralPath $path) {
        if ((Get-Item -LiteralPath $path).Length -gt 1048576) { throw 'STORE_CORRUPT' }
        try { $state=[IO.File]::ReadAllText($path,$script:Utf8)|ConvertFrom-Json } catch { throw 'STORE_CORRUPT' }
        Assert-R1Fields $state @('contract','receipts')
        if ($state.contract -cne $script:Contract -or @($state.receipts).Count -gt 256) { throw 'STORE_CORRUPT' }
        $ids=@{}; $keys=@{}
        foreach ($r in $state.receipts) {
            Assert-R1Fields $r @('requestId','key','previewDigest','ttlSeconds','oldPid','oldBuildId','targetBuildId','expiresAt','nonce','digest','state','code','updatedAt','history','approval','evidence')
            if ($r.state -notin @('accepted','approved','dispatching','running','completed','failed','unknown') -or
                $r.digest -cne (Get-R1Digest (Get-R1Exact $r)) -or $ids.ContainsKey($r.requestId) -or $keys.ContainsKey($r.key)) { throw 'STORE_CORRUPT' }
            $ids[$r.requestId]=$true; $keys[$r.key]=$true
        }
    }
    $engine=[pscustomobject]@{root=$Root; policy=$Policy; snapshot=$Snapshot; execute=$Execute; postcheck=$Postcheck; state=$state; poisoned=$false; lastNow=[DateTime]::UtcNow}
    foreach ($r in $state.receipts) {
        if ([DateTime]::Parse($r.updatedAt).ToUniversalTime() -gt $engine.lastNow) { throw 'CLOCK_ROLLBACK' }
        if ($r.state -in @('dispatching','running')) { Set-R1State $engine $r 'unknown' 'OWNER_INTERRUPTED_NO_RETRY' }
        elseif ($r.state -eq 'approved') { Set-R1State $engine $r 'failed' 'OWNER_RESTARTED_REAPPROVAL_REQUIRED' }
    }
    return $engine
}
function Get-R1PublicReceipt($Receipt) {
    return [pscustomobject]@{contract=$script:Contract; requestId=$Receipt.requestId; component='codex_bridge'; action='reload_runtime';
        oldPid=$Receipt.oldPid; oldBuildId=$Receipt.oldBuildId; targetBuildId=$Receipt.targetBuildId; expiresAt=$Receipt.expiresAt;
        digest=$Receipt.digest; state=$Receipt.state; code=$Receipt.code; updatedAt=$Receipt.updatedAt;
        history=@($Receipt.history); evidence=$Receipt.evidence; retryAllowed=$false}
}
function Assert-R1Snapshot($Snapshot) {
    Assert-R1Fields $Snapshot @('oldPid','oldBuildId','targetBuildId','active','awaitingApproval','controller','scope','drainRequestId','drainExpiresAt','ownerVerified')
    if ($Snapshot.ownerVerified -cne $true -or $Snapshot.oldPid -isnot [int] -or $Snapshot.oldPid -le 0) { throw 'OWNER_UNKNOWN' }
    Assert-R1String $Snapshot.oldBuildId '\A[0-9a-f]{16}\z'
    Assert-R1String $Snapshot.targetBuildId '\A[0-9a-f]{16}\z'
    if ($Snapshot.scope -cne 'all' -or $Snapshot.active -isnot [int] -or $Snapshot.active -lt 0 -or
        $Snapshot.awaitingApproval -isnot [int] -or $Snapshot.awaitingApproval -lt 0) { throw 'ACTIVE_STATE_UNKNOWN' }
}
function Get-R1Preview($Engine) {
    $s=& $Engine.snapshot; Assert-R1Snapshot $s
    $exact=[ordered]@{contract=$script:Contract; component='codex_bridge'; action='reload_runtime'; oldPid=$s.oldPid; oldBuildId=$s.oldBuildId; targetBuildId=$s.targetBuildId}
    return [pscustomobject]@{contract=$script:Contract; deployment='DEPLOYED'; component='codex_bridge'; action='reload_runtime';
        oldPid=$s.oldPid; oldBuildId=$s.oldBuildId; targetBuildId=$s.targetBuildId; previewDigest=(Get-R1Digest $exact);
        active=$s.active; awaitingApproval=$s.awaitingApproval; maxTtlSeconds=1800; maxReceipts=256}
}
function Test-R1Approval($Engine, $Receipt, $Assertion) {
    Assert-R1Fields $Assertion @('credentialId','clientDataJSON','authenticatorData','signature')
    foreach ($name in @('credentialId','clientDataJSON','authenticatorData','signature')) { Assert-R1String $Assertion.$name '\A[A-Za-z0-9_-]{1,8192}\z' }
    if ($Assertion.credentialId -cne $Engine.policy.credentialId) { throw 'INVALID_ASSERTION' }
    try { $client=$script:Utf8.GetString([McpCcReloadNative]::Decode($Assertion.clientDataJSON)) | ConvertFrom-Json } catch { throw 'INVALID_ASSERTION' }
    if ($client.type -cne 'webauthn.get' -or $client.challenge -cne [McpCcReloadNative]::Encode($script:Utf8.GetBytes($Receipt.digest)) -or
        $client.origin -cne $Engine.policy.origin) { throw 'INVALID_ASSERTION' }
    $cross=$client.PSObject.Properties['crossOrigin']; $top=$client.PSObject.Properties['topOrigin']
    if ($null -ne $cross -and $cross.Value -isnot [bool]) { throw 'INVALID_ASSERTION' }
    if ($null -ne $cross -and $cross.Value) {
        if ($null -eq $top -or $top.Value -cne $Engine.policy.topOrigin -or [string]::IsNullOrWhiteSpace($Engine.policy.topOrigin)) { throw 'INVALID_ASSERTION' }
    } elseif ($null -ne $top) { throw 'INVALID_ASSERTION' }
    [McpCcReloadNative]::Verify($Engine.policy.x,$Engine.policy.y,$Engine.policy.rpId,$Assertion.authenticatorData,$Assertion.clientDataJSON,$Assertion.signature)
}
function Invoke-R1Message($Engine, $Message) {
    if ($Engine.poisoned) { throw 'STORE_CORRUPT' }
    Assert-R1Clock $Engine
    Assert-R1Fields $Message @('contract','operation','arguments')
    if ($Message.contract -cne $script:Contract) { throw 'CONTRACT_MISMATCH' }
    $a=$Message.arguments
    switch -CaseSensitive ($Message.operation) {
        'status' {
            Assert-R1Fields $a @()
            return [pscustomobject]@{contract=$script:Contract; deployment='DEPLOYED'; executor='mcp_control_center'; administrator=$false;
                approval='webauthn-es256-exact-request'; receiptCount=@($Engine.state.receipts).Count; hostSchemaVerified=$false}
        }
        'preview' { Assert-R1Fields $a @(); return Get-R1Preview $Engine }
        'request' {
            Assert-R1Fields $a @('idempotencyKey','previewDigest','ttlSeconds')
            Assert-R1String $a.idempotencyKey '\A[A-Za-z0-9_-]{16,80}\z'; Assert-R1String $a.previewDigest '\A[0-9a-f]{64}\z'
            if ($a.ttlSeconds -isnot [int] -or $a.ttlSeconds -lt 60 -or $a.ttlSeconds -gt 1800) { throw 'INVALID_MESSAGE' }
            $previous=@($Engine.state.receipts | Where-Object { $_.key -ceq $a.idempotencyKey })
            if ($previous.Count -gt 0) {
                if ($previous[0].previewDigest -cne $a.previewDigest -or $previous[0].ttlSeconds -ne $a.ttlSeconds) { throw 'IDEMPOTENCY_CONFLICT' }
                return Get-R1PublicReceipt $previous[0]
            }
            if (@($Engine.state.receipts).Count -ge 256) { throw 'RECEIPT_LIMIT' }
            if (@($Engine.state.receipts | Where-Object { $_.state -in @('accepted','approved','dispatching','running','unknown') }).Count -gt 0) { throw 'REQUEST_BUSY' }
            $p=Get-R1Preview $Engine
            if ($p.previewDigest -cne $a.previewDigest) { throw 'PREVIEW_STALE' }
            $r=[pscustomobject]@{requestId=[guid]::NewGuid().ToString(); key=$a.idempotencyKey; previewDigest=$a.previewDigest; ttlSeconds=$a.ttlSeconds;
                oldPid=$p.oldPid; oldBuildId=$p.oldBuildId; targetBuildId=$p.targetBuildId; expiresAt=[DateTime]::UtcNow.AddSeconds($a.ttlSeconds).ToString('o');
                nonce=[McpCcReloadNative]::Nonce(); digest=''; state='accepted'; code='HUMAN_APPROVAL_REQUIRED'; updatedAt=''; history=@(); approval=$null; evidence=$null}
            $r.digest=Get-R1Digest (Get-R1Exact $r); $Engine.state.receipts=@($Engine.state.receipts)+@($r)
            Set-R1State $Engine $r 'accepted' 'HUMAN_APPROVAL_REQUIRED'
            return Get-R1PublicReceipt $r
        }
        { $_ -cin @('receipt','challenge','approve','resolve') } {
            $fields=if ($_ -ceq 'approve') { @('requestId','digest','assertion') } elseif ($_ -ceq 'challenge') { @('requestId','digest') } else { @('requestId') }
            Assert-R1Fields $a $fields; Assert-R1String $a.requestId '\A[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\z'
            $found=@($Engine.state.receipts | Where-Object { $_.requestId -ceq $a.requestId })
            if ($found.Count -ne 1) { throw 'RECEIPT_NOT_FOUND' }; $r=$found[0]
            if ($_ -ceq 'receipt') { return Get-R1PublicReceipt $r }
            if ($_ -ceq 'resolve') {
                if ($r.state -ceq 'accepted') { Set-R1State $Engine $r 'failed' 'APPROVAL_NOT_DELIVERED' }
                return Get-R1PublicReceipt $r
            }
            if ($a.digest -cne $r.digest -or $r.digest -cne (Get-R1Digest (Get-R1Exact $r))) { throw 'DIGEST_MISMATCH' }
            if ([DateTime]::UtcNow -ge [DateTime]::Parse($r.expiresAt).ToUniversalTime()) { throw 'REQUEST_EXPIRED' }
            if ($_ -ceq 'challenge') {
                if ($r.state -cne 'accepted') { throw 'APPROVAL_ALREADY_CONSUMED' }
                return [pscustomobject]@{receipt=(Get-R1PublicReceipt $r); publicKey=[pscustomobject]@{challenge=[McpCcReloadNative]::Encode($script:Utf8.GetBytes($r.digest));
                    rpId=$Engine.policy.rpId; credentialId=$Engine.policy.credentialId; userVerification='required'; timeout=60000}}
            }
            Test-R1Approval $Engine $r $a.assertion
            if ($r.state -ne 'accepted') { return Get-R1PublicReceipt $r } # signed retry never re-arms
            $r.approval=$a.assertion; Set-R1State $Engine $r 'approved' 'WAITING_FOR_IDLE'
            return Get-R1PublicReceipt $r
        }
        default { throw 'OPERATION_NOT_ALLOWED' }
    }
}
function Invoke-R1Tick($Engine) {
    if ($Engine.poisoned) { throw 'STORE_CORRUPT' }
    Assert-R1Clock $Engine
    foreach ($r in @($Engine.state.receipts | Where-Object { $_.state -in @('accepted','approved') })) {
        if ([DateTime]::UtcNow -ge [DateTime]::Parse($r.expiresAt).ToUniversalTime()) { Set-R1State $Engine $r 'failed' 'REQUEST_EXPIRED'; continue }
        if ($r.state -eq 'accepted') { continue }
        try {
            if ($r.digest -cne (Get-R1Digest (Get-R1Exact $r))) { throw 'DIGEST_MISMATCH' }
            Test-R1Approval $Engine $r $r.approval
            $s=& $Engine.snapshot; Assert-R1Snapshot $s
            if ($s.oldPid -ne $r.oldPid -or $s.oldBuildId -cne $r.oldBuildId -or $s.targetBuildId -cne $r.targetBuildId) { throw 'IDENTITY_CHANGED' }
            if ($s.active -ne 0 -or $s.awaitingApproval -ne 0 -or $s.controller -notin @('idle','ready')) { continue }
            if ($s.drainRequestId -cne $r.requestId -or $s.drainExpiresAt -cne $r.expiresAt) { continue }
            Set-R1State $Engine $r 'dispatching' 'DISPATCH_COMMITTED_NO_RETRY'
            Set-R1State $Engine $r 'running' 'CONTROLLER_DELEGATED'
            $result=& $Engine.execute $r
            $evidence=& $Engine.postcheck $r $result
            $r.evidence=$evidence
            if ($evidence.ok -cne $true) { throw 'POSTCHECK_FAILED' }
            $code=if ($evidence.schema.verified) {'VERIFIED_LOCAL_RELOAD'} else {'LOCAL_RELOAD_VERIFIED_SCHEMA_PENDING'}
            Set-R1State $Engine $r 'completed' $code
        } catch {
            $code=Get-R1SafeCode $_
            if ($r.state -in @('running','dispatching')) { Set-R1State $Engine $r 'unknown' $code }
            else { Set-R1State $Engine $r 'failed' $code }
        }
    }
}
function Get-R1SafeCode($ErrorRecord) {
    $code=[string]$ErrorRecord.Exception.Message
    $allowed=@('INVALID_MESSAGE','CONTRACT_MISMATCH','INVALID_ASSERTION','INVALID_SIGNATURE','OPERATION_NOT_ALLOWED','STORE_LIMIT','STORE_CORRUPT','CLOCK_ROLLBACK',
        'OWNER_UNKNOWN','ACTIVE_STATE_UNKNOWN','IDEMPOTENCY_CONFLICT','RECEIPT_LIMIT','REQUEST_BUSY','PREVIEW_STALE','RECEIPT_NOT_FOUND',
        'DIGEST_MISMATCH','REQUEST_EXPIRED','APPROVAL_ALREADY_CONSUMED','IDENTITY_CHANGED','POSTCHECK_FAILED','IPC_UNAUTHORIZED','IPC_IDENTITY_UNKNOWN')
    if ($code -cin $allowed) { return $code }; return 'RELOAD_UNAVAILABLE'
}
Export-ModuleMember -Function *-R1*
