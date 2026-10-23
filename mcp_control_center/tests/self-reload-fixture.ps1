param([Parameter(Mandatory=$true)][string]$Root)
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
# Synthetic process only: no production controller, registry, private state, HTTP or pipe is used.
Import-Module (Join-Path $PSScriptRoot '..\src\McpControlCenter.SelfReload.psm1')
$script:fixture=$null; $script:engine=$null; $script:executions=0; $script:mode='ok'
$script:fileLock=$null
function Start-FixtureEngine {
    New-R1Engine -Root $Root -Policy $script:fixture.policy -Snapshot { $script:fixture.snapshot } -Execute {
        param($receipt)
        $script:executions++
        if ($script:mode -eq 'crash') { [Environment]::Exit(17) }
        if ($script:mode -eq 'failure') { throw 'SYNTHETIC_CONTROLLER_FAILURE' }
        $script:fixture.snapshot.oldPid++
        $script:fixture.snapshot.oldBuildId=$receipt.targetBuildId
        return [pscustomobject]@{delegated=$true;exitCode=0}
    } -Postcheck {
        param($receipt,$action)
        return [pscustomobject]@{ok=($script:mode -ne 'post-failure');oldPid=$receipt.oldPid;newPid=$script:fixture.snapshot.oldPid;
            canonicalBuildId=$receipt.targetBuildId;healthVerified=$true;tunnelReady='ready';
            schema=[pscustomobject]@{verified=($script:mode -ne 'schema-auth-required');hostCacheVerified=$false};remoteHostVerified=$false;synthetic=$true}
    }
}
while ($null -ne ($line=[Console]::ReadLine())) {
    try {
        $message=$line|ConvertFrom-Json
        switch ($message.operation) {
            '__init' { $script:fixture=$message.arguments; $script:engine=Start-FixtureEngine; $result=@{ready=$true} }
            '__snapshot' { $script:fixture.snapshot=$message.arguments; $result=@{ok=$true} }
            '__mode' { $script:mode=$message.arguments.mode; $result=@{ok=$true} }
            '__tick' { Invoke-R1Tick $script:engine; $result=@{executions=$script:executions} }
            '__rollbackClock' { $script:engine.lastNow=[DateTime]::UtcNow.AddMinutes(1);$result=@{ok=$true} }
            '__restart' { $script:engine=Start-FixtureEngine; $result=@{executions=$script:executions} }
            '__blockWrite' {
                if ($message.arguments.mode -eq 'replace') { $script:fileLock=[IO.File]::Open((Join-Path $Root 'receipts.json'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read) }
                else { [void][IO.Directory]::CreateDirectory((Join-Path $Root 'receipts.next')) }
                $result=@{ok=$true}
            }
            '__unblockWrite' {
                if ($script:fileLock) {$script:fileLock.Dispose();$script:fileLock=$null}
                if ([IO.Directory]::Exists((Join-Path $Root 'receipts.next'))) {[IO.Directory]::Delete((Join-Path $Root 'receipts.next'))}
                $result=@{executions=$script:executions;poisoned=$script:engine.poisoned}
            }
            '__expire' {
                # The clock seam uses an already correctly digested but past exact request.
                $r=$script:engine.state.receipts[-1];$r.expiresAt=[DateTime]::UtcNow.AddSeconds(-1).ToString('o');$r.digest=Get-R1Digest (Get-R1Exact $r)
                Save-R1State $script:engine; $result=Get-R1PublicReceipt $r
            }
            '__capacity' { $script:engine.state.receipts=@(1..256 | ForEach-Object { [pscustomobject]@{key="old-$_";state='completed'} }); $result=@{ok=$true} }
            default { $result=Invoke-R1Message $script:engine $message }
        }
        $response=@{contract='remote-self-reload-r1';ok=$true;result=$result}
    } catch {
        [Console]::Error.WriteLine("SYNTHETIC_FIXTURE: $($_.Exception.Message) at $($_.ScriptStackTrace)")
        $response=@{contract='remote-self-reload-r1';ok=$false;code=(Get-R1SafeCode $_)}
    }
    [Console]::WriteLine(($response|ConvertTo-Json -Depth 25 -Compress))
}
