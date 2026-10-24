# Bridge-owned credential IO. Callers must validate the immutable release/closure
# and original operator before loading this file. No output contains credentials.
Set-StrictMode -Version 3.0

function Get-CbBearerPath($Release,$Verifier) {
    $identity=& $Verifier {Get-McpCcInstalledOperator}
    $canonical=Join-Path $Release.legacyWorkspaceRoot 'codex_bridge\.local\runtime'
    if($Release.schemaVersion -ne 6 -or $identity.isAdmin -or
        $identity.sid -cne $Release.state.operatorSid -or
        $identity.userProfile -ine $Release.state.userProfile -or
        $identity.localAppData -ine $Release.state.localAppData -or
        $Release.state.dataDir -ine $canonical){throw 'BRIDGE_BEARER_SCOPE_REJECTED'}
    & $Verifier {param($p,$s) Assert-McpCcInstalledPrivatePath $p $s} $canonical $identity.sid
    return Join-Path $canonical '.bridge-http-bearer.dpapi'
}

function Assert-CbBearerFile($Path,$Release,$Verifier) {
    & $Verifier {param($p,$s) Assert-McpCcInstalledPrivatePath $p $s} $Path $Release.state.operatorSid
    $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    $acl=Get-Acl -LiteralPath $Path -ErrorAction Stop
    if($item.PSIsContainer -or $item.Length -gt 65536 -or
        $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $Release.state.operatorSid){throw 'BRIDGE_BEARER_FILE_REJECTED'}
}

function Read-CbBearerSecret($Release,$Verifier) {
    $path=Get-CbBearerPath $Release $Verifier
    Assert-CbBearerFile $path $Release $Verifier
    $stream=$null;$reader=$null;$secure=$null;$bstr=[IntPtr]::Zero
    try {
        # Keep the same ciphertext locked against write/delete through decryption.
        $stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        Assert-CbBearerFile $path $Release $Verifier
        $reader=New-Object IO.StreamReader($stream,[Text.Encoding]::ASCII)
        try {
            $secure=ConvertTo-SecureString ($reader.ReadToEnd()) -ErrorAction Stop
            $bstr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
            $value=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        } catch {throw 'BRIDGE_BEARER_DECRYPT_FAILED'}
        $null=& $Verifier {param($t) Get-McpCcInstalledTokenHash $t} $value
        if([string]::IsNullOrEmpty($value)){throw 'BRIDGE_BEARER_EMPTY'}
        return $value
    } finally {
        if($bstr -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)}
        if($secure){$secure.Dispose()};if($reader){$reader.Dispose()}elseif($stream){$stream.Dispose()}
        $value=$null
    }
}

function Read-CbPersistedBearer($Release,$Verifier,[string]$ExpectedPin) {
    if($ExpectedPin -cnotmatch '^[0-9a-f]{64}$'){throw 'BRIDGE_BEARER_PIN_REQUIRED'}
    $value=Read-CbBearerSecret $Release $Verifier
    try {
        $digest=& $Verifier {param($t) Get-McpCcInstalledTokenHash $t} $value
        if($digest -cne $ExpectedPin){throw 'INSTALLED_HTTP_AUTH_MISMATCH'}
        return $value
    } finally {$value=$null}
}

function Set-CbInstalledBearerEnvironment($Release,$Verifier) {
    # Tokenless releases never inspect or adopt a provisioned successor's secret.
    if($Release.schemaVersion -ne 6 -or $Release.cutover.httpTokenSha256 -ceq ''){return}
    $current=[Environment]::GetEnvironmentVariable('CODEX_BRIDGE_HTTP_TOKEN','Process')
    if($current -and (& $Verifier {param($t) Get-McpCcInstalledTokenHash $t} $current) -cne $Release.cutover.httpTokenSha256){throw 'INSTALLED_HTTP_AUTH_MISMATCH'}
    $value=Read-CbPersistedBearer $Release $Verifier $Release.cutover.httpTokenSha256
    try {[Environment]::SetEnvironmentVariable('CODEX_BRIDGE_HTTP_TOKEN',$value,'Process')}
    finally {$value=$null;$current=$null}
}

function Initialize-CbInstalledBearer($Previous,$Verifier) {
    # Only the existing independent operator's explicit Prepare switch calls this.
    # Resume a valid, not-yet-adopted secret after an offline packaging failure.
    # Never overwrite it, rotate an existing pin, or accept a caller-selected token.
    Assert-IndependentOperator
    if($Previous.cutover.httpTokenSha256 -cne ''){throw 'BRIDGE_BEARER_INITIALIZATION_REJECTED'}
    $path=Get-CbBearerPath $Previous $Verifier
    $current=[Environment]::GetEnvironmentVariable('CODEX_BRIDGE_HTTP_TOKEN','Process')
    if(Test-Path -LiteralPath $path){
        $existing=Read-CbBearerSecret $Previous $Verifier
        try {
            if($current -and $current -cne $existing){throw 'INSTALLED_HTTP_AUTH_MISMATCH'}
            [Environment]::SetEnvironmentVariable('CODEX_BRIDGE_HTTP_TOKEN',$existing,'Process')
        } finally {$existing=$null;$current=$null}
        return
    }
    if($current){throw 'BRIDGE_BEARER_INITIALIZATION_REJECTED'}
    $stream=$null;$secure=$null;$rng=$null;$bytes=New-Object byte[] 32;$cipherBytes=$null
    try {
        # CreateNew is the atomic one-time reservation. Inherit the already verified
        # private parent ACL, then verify exact file owner before writing any bytes.
        $stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        Assert-CbBearerFile $path $Previous $Verifier
        $rng=[Security.Cryptography.RandomNumberGenerator]::Create();$rng.GetBytes($bytes)
        $value=[Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
        $secure=ConvertTo-SecureString $value -AsPlainText -Force
        $cipherBytes=[Text.Encoding]::ASCII.GetBytes((ConvertFrom-SecureString $secure -ErrorAction Stop))
        $stream.Write($cipherBytes,0,$cipherBytes.Length);$stream.Flush($true);$stream.Dispose();$stream=$null
        $pin=& $Verifier {param($t) Get-McpCcInstalledTokenHash $t} $value
        $verified=Read-CbPersistedBearer $Previous $Verifier $pin
        [Environment]::SetEnvironmentVariable('CODEX_BRIDGE_HTTP_TOKEN',$verified,'Process')
    } finally {
        if($stream){$stream.Dispose()};if($rng){$rng.Dispose()};if($secure){$secure.Dispose()}
        [Array]::Clear($bytes,0,$bytes.Length)
        if($cipherBytes){[Array]::Clear($cipherBytes,0,$cipherBytes.Length)}
        $value=$null;$verified=$null;$pin=$null
    }
}
