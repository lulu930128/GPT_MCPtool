[CmdletBinding()]
param()
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$componentRoot=Split-Path -Parent $PSScriptRoot
$sources=@(
    (Join-Path $componentRoot 'src\NormalOperator.Native.cs'),
    (Join-Path $componentRoot 'src\NormalOperator.Pipe.cs'),
    (Join-Path $componentRoot 'src\NormalOperator.Security.cs'),
    (Join-Path $PSScriptRoot 'NormalPipeHandler.Check.cs')
)
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin=([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$receipt=[ordered]@{
    contract='normal-pipe-handler-manual-v1'; at=[DateTime]::UtcNow.ToString('o')
    status='UNVERIFIED'; processId=$PID; identity=$identity.Name; sid=$identity.User.Value
    elevated=$isAdmin; inAnyJob=$null; operation='nonadmin precondition'
    errorCode=$null; errorType=$null; hresult=$null; nativeErrorCode=$null; nativeOperation=$null
    layer=$null; sourceHashes=@(); checks=@()
    protectedHost='UNVERIFIED'; productionEnabled=$false; markerExecuted=$false
    secretsRead=$false; persistentAclChanged=$false; serviceStarted=$false
}
$identity.Dispose()
$exitCode=1
$receiptPath=$null
try {
    if ($isAdmin) { throw 'NONADMIN_REQUIRED_DO_NOT_ELEVATE' }
    $receipt.operation='create isolated receipt directory'
    $ccRoot=[IO.Path]::GetFullPath($componentRoot).TrimEnd('\')
    $temporaryRoot=[IO.Path]::GetFullPath((Join-Path $ccRoot '.tmp'))
    $outputRoot=[IO.Path]::GetFullPath((Join-Path $temporaryRoot 'normal-pipe-handler'))
    if ($temporaryRoot -ine ($ccRoot+'\.tmp') -or $outputRoot -ine ($temporaryRoot+'\normal-pipe-handler')) {
        throw 'TEST_OUTPUT_PATH_REJECTED'
    }
    # Only these two fixed output parents may be created. Existing directories must
    # not redirect the test's receipt writes through a symlink or junction.
    $ancestor=$ccRoot
    while ($ancestor) {
        $item=Get-Item -LiteralPath $ancestor -Force
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'TEST_OUTPUT_REPARSE_REJECTED'
        }
        if ($ancestor -ieq [IO.Path]::GetPathRoot($ancestor)) { break }
        $nextAncestor=Split-Path -Parent $ancestor
        if ($nextAncestor -ieq $ancestor) { throw 'TEST_OUTPUT_ANCESTRY_STALLED' }
        $ancestor=$nextAncestor
    }
    foreach ($directory in @($temporaryRoot,$outputRoot)) {
        if (-not (Test-Path -LiteralPath $directory)) { $null=New-Item -ItemType Directory -Path $directory }
        $item=Get-Item -LiteralPath $directory -Force
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'TEST_OUTPUT_REPARSE_REJECTED'
        }
    }
    $case=[IO.Path]::GetFullPath((Join-Path $outputRoot ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+[Guid]::NewGuid().ToString('N'))))
    if ((Split-Path -Parent $case) -ine $outputRoot) { throw 'TEST_OUTPUT_PATH_REJECTED' }
    $null=New-Item -ItemType Directory -Path $case
    $receiptPath=Join-Path $case 'receipt.json'
    $receipt.operation='hash exact test source files'
    $receipt.sourceHashes=@(foreach($source in $sources) {
        [ordered]@{file=[IO.Path]::GetFileName($source);sha256=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()}
    })
    $receipt.operation='compile native transport and fixed handler in memory'
    Add-Type -Path $sources
    $method=[McpCcNormalPipe+Listener].GetMethod('Exchange')
    # Windows PowerShell 5.1 cannot parse nested array generic type syntax here.
    # Inspect the method's runtime type instead of using [Func[byte[],byte[]]].
    $handlerType=$method.GetParameters()[0].ParameterType
    $handlerArguments=@($handlerType.GetGenericArguments())
    if (-not $handlerType.IsGenericType -or
        $handlerType.GetGenericTypeDefinition().FullName -cne 'System.Func`2' -or
        $handlerArguments.Count -ne 2 -or
        $handlerArguments[0] -ne [byte[]] -or
        $handlerArguments[1] -ne [byte[]]) { throw 'HANDLER_CONTRACT_INVALID' }
    $receipt.operation='inspect current test process'
    $process=Get-Process -Id $PID
    try { $proof=[McpCcNormalNative]::Inspect($process); $token=[McpCcNormalSecurity]::Observe($process) } finally { $process.Dispose() }
    $receipt.inAnyJob=$proof.inAnyJob
    $receipt.operation='isolated native pipe verified-handler exchange'
    if($token.restricted) {
        $receipt.status='BLOCKED_RESTRICTED_TOKEN_POSITIVE_SKIPPED'
        $receipt.checks=@('native compilation only; no positive pipe exchange')
    } else {
        $receipt.status=[NormalPipeHandlerCheck]::Run()
        $receipt.checks=@('request determines verified response','handler called once','handler rejection closes without response')
    }
    $receipt.operation='completed isolated checks'
    $exitCode=0
} catch {
    $cause=$_.Exception
    while($null -ne $cause.InnerException) { $cause=$cause.InnerException }
    $receipt.status='FAILED'
    $receipt.errorCode=$cause.Message
    $receipt.errorType=$cause.GetType().FullName
    $receipt.hresult=$cause.HResult
    if($cause -is [ComponentModel.Win32Exception]) { $receipt.nativeErrorCode=$cause.NativeErrorCode }
    if($cause.Data.Contains('operation')) { $receipt.nativeOperation=[string]$cause.Data['operation'] }
    $receipt.layer=if($cause -is [UnauthorizedAccessException] -or $receipt.nativeErrorCode -eq 5) {
        'PERMISSION_SOURCE_OR_ENVIRONMENT_UNRESOLVED'
    } else { 'SOURCE_OR_ENVIRONMENT' }
    # Stop on the first failure. No fallback transport, access-mask retry, elevation,
    # ACL repair, service/task/Startup operation, or automatic second test attempt.
}
$json=$receipt | ConvertTo-Json -Depth 6
if ($null -ne $receiptPath) {
    try {
        [IO.File]::WriteAllText($receiptPath,$json,(New-Object Text.UTF8Encoding($false)))
    } catch {
        $cause=$_.Exception
        while($null -ne $cause.InnerException) { $cause=$cause.InnerException }
        $json
        [pscustomobject]@{status='RECEIPT_WRITE_FAILED';operation='write ignored receipt';hresult=$cause.HResult;errorCode=$cause.Message;processId=$PID} | ConvertTo-Json -Compress
        exit 1
    }
}
$json
if ($null -ne $receiptPath) { Write-Output ('Receipt: '+$receiptPath) }
exit $exitCode
