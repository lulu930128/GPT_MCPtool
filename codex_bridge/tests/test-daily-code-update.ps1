# Offline only: real staging/hash/selector/journal engine; lifecycle is an in-memory fixture.
param([switch]$StageOnly)
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$module=Import-Module (Join-Path $repo 'mcp_control_center\src\McpControlCenter.DailyCode.psm1') -Force -PassThru
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('mcp-daily-fixture-'+[guid]::NewGuid().ToString('N'))
$passed=0
function Check([bool]$Value,[string]$Name){if(-not $Value){throw "FAILED: $Name"};$script:passed++}
function Denied([scriptblock]$Body,[string]$Pattern){$message='';try{& $Body|Out-Null}catch{$message=$_.Exception.Message};Check ($message -match $Pattern) ($Pattern+' observed='+$message)}
function Put([string]$Path,[string]$Text){[void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path));[IO.File]::WriteAllText($Path,$Text)}
function New-Case([string]$Name,[switch]$StageOnly) {
    $root=Join-Path $fixture $Name;$source=Join-Path $root 'source';$runtime=Join-Path $root 'Runtime'
    foreach($file in @('codex_bridge/src/view.ts','codex_bridge/dist/src/http-main.js','codex_bridge/web/index.html',
        'codex_bridge/scripts/daily-code-owner.ps1','codex_bridge/scripts/daily-runtime-settings.ps1','codex_bridge/scripts/daily-bearer.ps1',
        'codex_bridge/scripts/cooperative-layout.ps1',
        'codex_bridge/control-center/component.json','codex_bridge/node_modules/pkg/index.js','codex_bridge/package.json','codex_bridge/package-lock.json','codex_bridge/daily-code-contract.json',
        'mcp_control_center/src/McpControlCenter.Core.psm1','mcp_control_center/scripts/tray.ps1','mcp_control_center/scripts/start-daily-tray.vbs','mcp_control_center/config/registry.json',
        'mcp_control_center/src/NormalOperator.Native.cs','mcp_control_center/src/RemoteSelfReload.Native.cs',
        'codex_bridge/node_modules/pkg/data/table.json','codex_bridge/node_modules/pkg/lib/runtime/index.js',
        'codex_bridge/node_modules/pkg/dist/runtime/index.js','codex_bridge/node_modules/@scope/pkg/data/table.json',
        'codex_bridge/node_modules/@scope/pkg/dist/token.js','codex_bridge/node_modules/@scope/pkg/dist/token.d.ts',
        'codex_bridge/node_modules/@scope/pkg/dist/token.js.map','codex_bridge/node_modules/@scope/pkg/dist/token.d.ts.map',
        'codex_bridge/src/tokenizer.ts','codex_bridge/dist/src/tokenizer.js','codex_bridge/src/runtime/index.ts')) {
        Put (Join-Path $source $file) 'fixture code v1'
    }
    # Private files outside the explicit trees are never traversed or copied.
    Put (Join-Path $source 'codex_bridge/.env') 'fixture-private-sentinel'
    Put (Join-Path $source 'codex_bridge/.local/jobs.json') 'fixture-private-sentinel'
    $null=New-McpDailyCandidate -Root $runtime -Source $source -Version v1
    Put (Join-Path $source 'codex_bridge/web/index.html') 'fixture code v2'
    $null=New-McpDailyCandidate -Root $runtime -Source $source -Version v2
    if($StageOnly){return @{root=$runtime;source=$source}}
    Put (Join-Path $runtime 'settings.json') '{"fixture":true}'
    & $module {param($r)
        Write-DailyNew (Join-Path $r 'adoption.json') @{settingsSha256=(Get-DailyDigest (Join-Path $r 'settings.json'))}
        Set-DailySelector $r v1
        $script:Calls=New-Object 'Collections.Generic.List[string]'
        $script:Scenario='normal'
        function script:Read-DailySettingsForVersion {param($Root,$Version) return @{fixture=$true}}
        function script:Invoke-DailyOwner {
            param($Root,$Version,$Action)
            $script:Calls.Add($Version+':'+$Action)
            if($script:Scenario -eq 'foreign' -and $Action -eq 'Stop'){throw 'OWNERSHIP_MISMATCH'}
            if($script:Scenario -eq 'active' -and $Action -eq 'Stop'){throw 'ACTIVE_WORK_PRESENT'}
            if($script:Scenario -eq 'lock' -and $Action -eq 'Stopped'){throw 'DAILY_STATE_LOCK_PRESENT'}
            if($script:Scenario -eq 'unknown' -and $Action -eq 'Stop'){throw 'COOPERATIVE_SHUTDOWN_UNKNOWN'}
            if($script:Scenario -eq 'fail' -and $Version -eq 'v2' -and $Action -eq 'Ready'){throw 'DAILY_READINESS_FAILED'}
        }
    } $runtime
    return @{root=$runtime;source=$source}
}
try {
    $stageCase=New-Case stage -StageOnly
    $manifest=& $module {param($r) Test-DailyVersion $r v1} $stageCase.root
    $inbox=Join-Path $stageCase.root 'versions/v1/codex_bridge/.tmp/codex-inbox'
    [void][IO.Directory]::CreateDirectory($inbox)
    $withInbox=& $module {param($r) Test-DailyVersion $r v1} $stageCase.root
    Check (($manifest.files|ConvertTo-Json -Compress) -ceq ($withInbox.files|ConvertTo-Json -Compress)) 'empty runtime inbox leaves full code inventory unchanged'
    Denied {& $module {param($r) Get-DailyFiles (Join-Path $r 'versions/v1')} $stageCase.root} '^DAILY_PRIVATE_FILE_REJECTED'
    $inboxFile=Join-Path $inbox 'fixture.txt';Put $inboxFile 'synthetic private fixture'
    Denied {& $module {param($r) Test-DailyVersion $r v1} $stageCase.root} '^DAILY_PRIVATE_FILE_REJECTED'
    [IO.File]::Delete($inboxFile)
    $extra=Join-Path (Split-Path -Parent $inbox) 'other';[void][IO.Directory]::CreateDirectory($extra)
    Denied {& $module {param($r) Test-DailyVersion $r v1} $stageCase.root} '^DAILY_PRIVATE_FILE_REJECTED'
    [IO.Directory]::Delete($extra,$false)
    $codeFile=Join-Path $stageCase.root 'versions/v1/codex_bridge/web/index.html'
    $codeBefore=[IO.File]::ReadAllBytes($codeFile);Put $codeFile 'tampered code fixture'
    Denied {& $module {param($r) Test-DailyVersion $r v1} $stageCase.root} '^DAILY_INTEGRITY_FAILED$'
    [IO.File]::WriteAllBytes($codeFile,$codeBefore)
    $expected=@(Get-ChildItem -LiteralPath $stageCase.source -File -Recurse -Force |
        ForEach-Object {$_.FullName.Substring($stageCase.source.Length+1).Replace('\','/')} |
        Where-Object {$_ -like 'codex_bridge/*' -and $_ -notmatch '^codex_bridge/(\.env|\.local)(/|$)'} | Sort-Object)
    $expected=@($expected)+@('codex_bridge/scripts/shared-native/NormalOperator.Native.cs','codex_bridge/scripts/shared-native/RemoteSelfReload.Native.cs')
    Check ((@($expected | Sort-Object) -join "`n") -ceq (@($manifest.files.path) -join "`n")) 'Stage retains Bridge and explicit native dependencies without another Control Center'
    foreach($name in @('NormalOperator.Native.cs','RemoteSelfReload.Native.cs')){
        Check ((Get-FileHash -LiteralPath (Join-Path $stageCase.root ('versions/v1/codex_bridge/scripts/shared-native/'+$name))).Hash -ceq
            (Get-FileHash -LiteralPath (Join-Path $stageCase.source ('mcp_control_center/src/'+$name))).Hash) 'native dependency matches canonical source'
    }
    Check (-not(Test-Path -LiteralPath (Join-Path $stageCase.root 'versions/v1/mcp_control_center'))) 'Bridge package never includes CC'
    $nativeSource=Join-Path $stageCase.source 'mcp_control_center/src/NormalOperator.Native.cs'
    $nativeBytes=[IO.File]::ReadAllBytes($nativeSource);[IO.File]::Delete($nativeSource)
    Denied {New-McpDailyCandidate -Root $stageCase.root -Source $stageCase.source -Version missing-native} '^DAILY_CANDIDATE_INCOMPLETE: mcp_control_center/src/NormalOperator.Native.cs$'
    Check (-not(Test-Path -LiteralPath (Join-Path $stageCase.root 'versions/missing-native'))) 'missing native is rejected before publishing'
    [IO.File]::WriteAllBytes($nativeSource,$nativeBytes)
    foreach($name in @('current.json','adoption.json','settings.json','operations','update.lock')) {
        Check (-not(Test-Path -LiteralPath (Join-Path $stageCase.root $name))) ('Stage does not create '+$name)
    }
    Denied {New-McpDailyCandidate -Root $stageCase.root -Source $stageCase.source -Version v1} '^DAILY_VERSION_EXISTS$'
    # Direct path checks never open any real private file. These are synthetic names.
    foreach($path in @('codex_bridge/.env','codex_bridge/src/.env.production','codex_bridge/src/.local/jobs.json',
        'codex_bridge/src/config.local.json','codex_bridge/Runtime/current.json','codex_bridge/data/jobs.json',
        'mcp_control_center/config/data/jobs.json','codex_bridge/node_modules/pkg/.env',
        'codex_bridge/node_modules/pkg/.local/state.json','codex_bridge/node_modules/pkg/data/private.db',
        'codex_bridge/node_modules/pkg/data/private.sqlite3-wal','codex_bridge/src/credentials.json',
        'codex_bridge/src/Credential/state.json','codex_bridge/src/token-cache.json','codex_bridge/src/token.txt',
        'codex_bridge/src/secret.json','codex_bridge/src/auth.json','codex_bridge/src/private.pem',
        'codex_bridge/src/private.key','codex_bridge/src/private.pfx','codex_bridge/src/private.dpapi',
        'codex_bridge/src/.npmrc','codex_bridge/node_modules/pkg/logs/events.json','codex_bridge/src/server.log',
        'codex_bridge/src/server.pid','codex_bridge/src/backups/state.json','codex_bridge/src/exports/state.json')) {
        Denied {& $module {param($p) Assert-DailyCodePath $p} $path} '^DAILY_PRIVATE_FILE_REJECTED: codex_bridge/|^DAILY_PRIVATE_FILE_REJECTED: mcp_control_center/'
    }
    foreach($path in @('C:/private/file','codex_bridge/../file',"codex_bridge/src/bad`nname",'codex_bridge/src/file:stream','codex_bridge/src//file')) {
        Denied {& $module {param($p) Assert-DailyCodePath $p} $path} '^DAILY_PACKAGE_PATH_REJECTED$'
    }
    Denied {& $module {Assert-DailyCodePath 'codex_bridge/src/token-fixture-value.json'}} '^DAILY_PRIVATE_FILE_REJECTED: codex_bridge/src/<credential-name> \[rule=credential-file\]$'
    # A refusal in the final tree must precede every copy/hash, not leave a
    # partially copied candidate from earlier trees. Existing failures are retained.
    foreach($private in @('.env','.local/state.json','private.db')) {
        $caseName='private-'+($private -replace '[^a-z]','')
        $privateCase=New-Case $caseName -StageOnly
        $relative='codex_bridge/control-center/'+$private
        Put (Join-Path $privateCase.source $relative) 'fixture-private-sentinel'
        $retained=Join-Path $privateCase.root 'staging/old-failure/marker.txt'
        Put $retained 'fixture retained'
        Denied {New-McpDailyCandidate -Root $privateCase.root -Source $privateCase.source -Version rejected} ('^DAILY_PRIVATE_FILE_REJECTED: '+[regex]::Escape(($relative -replace '/state.json$',''))+' \[rule=')
        Check (-not(Test-Path -LiteralPath (Join-Path $privateCase.root 'versions/rejected'))) 'private input never publishes a version'
        Check (@(Get-ChildItem -LiteralPath (Join-Path $privateCase.root 'staging')).Count -eq 1) 'private preflight creates no new staging directory'
        Check ((Get-Content -LiteralPath $retained -Raw) -ceq 'fixture retained') 'existing failed staging retained'
    }
    if($StageOnly) {
        [pscustomobject]@{ok=$true;passed=$passed;scope='Stage';live=$false;processesChanged=$false;startupChanged=$false;aclChanged=$false}|ConvertTo-Json
        return
    }
    $case=New-Case normal
    Check (-not(Test-Path -LiteralPath (Join-Path $case.root 'versions\v1\codex_bridge\.env'))) 'private env excluded'
    Check (-not(Test-Path -LiteralPath (Join-Path $case.root 'versions\v1\codex_bridge\.local'))) 'private state excluded'
    Check ((Get-FileHash -LiteralPath (Join-Path $case.root 'versions\v1\codex_bridge\daily-code-contract.json')).Hash -ceq
        (Get-FileHash -LiteralPath (Join-Path $case.source 'codex_bridge\daily-code-contract.json')).Hash) 'contract copied byte-for-byte by real Stage'
    Denied {New-McpDailyCandidate -Root $case.root -Source $case.source -Version v1} 'VERSION_EXISTS'
    $result=Invoke-McpDailyUpdate -Root $case.root -Version v2 -CodeOnly
    Check ($result.phase -eq 'ACCEPTED') 'normal deployment'
    Check ((Get-McpDailyStatus $case.root).version -eq 'v2') 'selector changed'
    Check (Test-Path -LiteralPath (Join-Path $case.root 'versions\v1\daily-release.json')) 'old version retained'
    Check ((Invoke-McpDailyUpdate -Root $case.root -Version v2 -CodeOnly).phase -eq 'ALREADY_SELECTED') 'idempotent selected'
    $calls=@(& $module {$script:Calls.ToArray()})
    Check ($calls -notcontains 'v1:Ready') 'old health not a deployment gate'
    Check (@($calls|Where-Object {$_ -match 'Tray'}).Count -eq 0) 'Bridge update never stops or launches CC'
    $null=Start-McpDailyCurrent $case.root
    Check (@(@(& $module {$script:Calls.ToArray()})|Where-Object {$_ -match 'Tray'}).Count -eq 0) 'Bridge Start never launches CC'

    $case=New-Case unhealthy
    & $module {$script:Scenario='unhealthy'}
    Check ((Invoke-McpDailyUpdate -Root $case.root -Version v2 -CodeOnly).phase -eq 'ACCEPTED') 'unhealthy old deploys'

    foreach($scenario in @('foreign','active','unknown','lock')) {
        $case=New-Case $scenario
        & $module {param($s) $script:Scenario=$s} $scenario
        $pattern=@{foreign='OWNERSHIP_MISMATCH';active='ACTIVE_WORK_PRESENT';unknown='UNKNOWN';lock='DAILY_STATE_LOCK_PRESENT'}[$scenario]
        Denied {Invoke-McpDailyUpdate -Root $case.root -Version v2 -CodeOnly} $pattern
        Check ((Get-McpDailyStatus $case.root).version -eq 'v1') ($scenario+' selector preserved')
        $calls=@(& $module {$script:Calls.ToArray()})
        Check ($calls -notcontains 'v2:Start') ($scenario+' no new start')
        if($scenario -in @('unknown','lock')) {
            $count=$calls.Count
            Denied {Invoke-McpDailyUpdate -Root $case.root -Version v2 -CodeOnly} 'INTERRUPTED_UNKNOWN'
            Check ((@(& $module {$script:Calls.ToArray()})).Count -eq $count) 'unknown not replayed'
        }
    }
    $case=New-Case rollback
    & $module {$script:Scenario='fail'}
    Denied {Invoke-McpDailyUpdate -Root $case.root -Version v2 -CodeOnly} 'FAILED_ROLLED_BACK'
    Check ((Get-McpDailyStatus $case.root).version -eq 'v1') 'rollback restores selector'
    $calls=@(& $module {$script:Calls.ToArray()})
    Check (($calls -contains 'v2:Stop') -and ($calls -contains 'v1:Start') -and ($calls -contains 'v1:Ready')) 'rollback stops new and verifies old'
    Check (@($calls|Where-Object {$_ -match 'Tray'}).Count -eq 0) 'Bridge rollback leaves CC untouched'
    $terminal=Get-ChildItem -LiteralPath (Join-Path $case.root 'operations') -Filter terminal.json -Recurse | Get-Content -Raw | ConvertFrom-Json
    Check ($terminal.phase -eq 'ROLLED_BACK' -and $terminal.code -eq 'DAILY_READINESS_FAILED') 'original error retained'

    $case=New-Case interrupted
    [void][IO.Directory]::CreateDirectory((Join-Path $case.root 'operations\interrupted'))
    Denied {Invoke-McpDailyUpdate -Root $case.root -Version v2 -CodeOnly} 'INTERRUPTED_UNKNOWN'
    Check ((@(& $module {$script:Calls.ToArray()})).Count -eq 0) 'interruption has no lifecycle calls'

    $case=New-Case config
    Put (Join-Path $case.root 'settings.json') '{"fixture":false}'
    Denied {Invoke-McpDailyUpdate -Root $case.root -Version v2 -CodeOnly} 'CONFIG_CHANGED_MIGRATION_REQUIRED'
    $case=New-Case data
    Put (Join-Path $case.source 'codex_bridge/daily-code-contract.json') '{"persistentStateFormat":2}'
    $null=New-McpDailyCandidate -Root $case.root -Source $case.source -Version v3
    Denied {Invoke-McpDailyUpdate -Root $case.root -Version v3 -CodeOnly} 'MIGRATION_REQUIRED'
    Check ((@(& $module {$script:Calls.ToArray()})).Count -eq 0) 'state change rejected before stop'
    Put (Join-Path $case.source 'codex_bridge/scripts/credentials.json') 'fixture-secret'
    Denied {New-McpDailyCandidate -Root $case.root -Source $case.source -Version v4} 'PRIVATE_FILE_REJECTED'

    $case=New-Case nested
    Put (Join-Path $case.source 'codex_bridge/src/installed-runtime.ts') 'code-only bug fix, same binding contract'
    Put (Join-Path $case.source 'codex_bridge/src/powershell-approval/projection.ts') 'nested code-only fix'
    Put (Join-Path $case.source 'codex_bridge/dist/src/powershell-approval/projection.js') 'compiled nested code-only fix'
    $null=New-McpDailyCandidate -Root $case.root -Source $case.source -Version v3
    Check ((Invoke-McpDailyUpdate -Root $case.root -Version v3 -CodeOnly).phase -eq 'ACCEPTED') 'nested and installed-named code accepted'

    $case=New-Case integrity
    Put (Join-Path $case.root 'versions/v2/codex_bridge/web/index.html') 'tampered'
    Denied {Invoke-McpDailyUpdate -Root $case.root -Version v2 -CodeOnly} 'INTEGRITY_FAILED'
    $case=New-Case concurrent
    $lock=[IO.File]::Open((Join-Path $case.root 'update.lock'),'OpenOrCreate','ReadWrite','None')
    try {Denied {Invoke-McpDailyUpdate -Root $case.root -Version v2 -CodeOnly} '.+'}finally{$lock.Dispose()}

    # Execute the actual owner shutdown function with only IO/process primitives replaced.
    $runtimeModule=Import-Module (Join-Path $repo 'codex_bridge\scripts\codex-bridge-runtime.psm1') -Force -PassThru
    $stopRoot=Join-Path $fixture 'stop'
    Put (Join-Path $stopRoot 'daily-mode.json') '{}'
    [void][IO.Directory]::CreateDirectory((Join-Path $stopRoot 'codex_bridge'))
    & $runtimeModule {
        function script:Test-CbInstalledLayout {return $false}
        function script:Assert-CbShutdownPreflight {param($Context) if($script:Foreign){throw 'OWNERSHIP_MISMATCH'}}
        function script:Resolve-CbRoleOwnership {param($Context,$Role,[switch]$ReadOnly) return @{state='OwnedNotListening';pid=42;canMutate=$true}}
        function script:Open-CbOwnedProcess {
            param($ProcessId,[switch]$QueryOnly)
            $o=[pscustomobject]@{HasExited=$false;ProcessId=42;StartTimeUtc='2026-10-25T00:00:00Z';Timeout=$script:Timeout}
            $o|Add-Member ScriptMethod WaitForExit {param($ms) if($this.Timeout){return $false};$this.HasExited=$true}
            $o|Add-Member ScriptMethod Dispose {}
            return $o
        }
        function script:Test-CbExecutableIdentity {param($Context,$Role,$Process) return $true}
        function script:Test-CbOwnerMetadata {param($Context,$Role,$Process) return $true}
        function script:Invoke-CbCooperativeExchange {param($Context,$ProcessId,$Action,$ExpectedInstance) $script:DrainCalls++;if($script:Active){throw 'ACTIVE_WORK_PRESENT'}}
        function script:Remove-CbRuntimeFile {param($Path,$ExpectedPid) $script:MetadataRemovals++}
        function script:Stop-CbOwnedRole {param($Context,$Role,$StoppedCoreHandle) if(-not $StoppedCoreHandle.HasExited){throw 'CORE_NOT_EXITED'};$script:TunnelStops++}
        function script:Assert-CbIdleForMutation {throw 'HTTP_HEALTH_MUST_NOT_BE_USED'}
        $script:DrainCalls=0;$script:TunnelStops=0;$script:MetadataRemovals=0;$script:Foreign=$false;$script:Active=$false;$script:Timeout=$false
    }
    $ctx=@{projectRoot=(Join-Path $stopRoot 'codex_bridge');dataDir=(Join-Path $fixture 'state');serverPidFile='unused';serverOwnerFile='unused'}
    & $runtimeModule {param($c) Stop-CbRuntimeForDailyUpdate $c} $ctx
    Check ((& $runtimeModule {$script:DrainCalls -eq 1 -and $script:TunnelStops -eq 1})) 'real owner function stops unhealthy core through drain'
    & $runtimeModule {$script:Foreign=$true}
    Denied {& $runtimeModule {param($c) Stop-CbRuntimeForDailyUpdate $c} $ctx} 'OWNERSHIP_MISMATCH'
    Check ((& $runtimeModule {$script:DrainCalls -eq 1})) 'foreign PID never signalled'
    & $runtimeModule {$script:Foreign=$false;$script:Active=$true}
    Denied {& $runtimeModule {param($c) Stop-CbRuntimeForDailyUpdate $c} $ctx} 'ACTIVE_WORK_PRESENT'
    Check ((& $runtimeModule {$script:TunnelStops -eq 1})) 'active work preserves tunnel'
    & $runtimeModule {$script:Active=$false;$script:Timeout=$true}
    Denied {& $runtimeModule {param($c) Stop-CbRuntimeForDailyUpdate $c} $ctx} 'DAILY_STOP_UNKNOWN'
    Check ((& $runtimeModule {$script:MetadataRemovals -eq 2 -and $script:TunnelStops -eq 1})) 'timeout retains metadata and tunnel'

    # Execute the actual CLI Update clause without running its fixed live root.
    $tokens=$null;$errors=$null
    $entryAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'codex_bridge\scripts\daily-code-update.ps1'),[ref]$tokens,[ref]$errors)
    $switch=$entryAst.Find({param($n) $n -is [Management.Automation.Language.SwitchStatementAst]},$true)
    $clause=@($switch.Clauses | Where-Object {$_.Item1.Value -ceq 'Update'})[0].Item2.Extent.Text
    $update=[scriptblock]::Create($clause.Substring(1,$clause.Length-2))
    $cli=& {
        param($body)
        $script:order=New-Object 'Collections.Generic.List[string]'
        function New-McpDailyCandidate {param($Root,$Source,$Version) $script:order.Add('Stage');return @{phase='STAGED'}}
        function Invoke-McpDailyUpdate {param($Root,$Version,[switch]$CodeOnly) $script:order.Add('Update');return @{phase='ACCEPTED'}}
        $root='fixture';$CandidateRoot='source';$Version='v1';$CodeOnly=$true
        & $body | Out-Null
        return ($script:order -join ',')
    } $update
    Check ($cli -ceq 'Stage,Update') 'actual CLI one-command Stage then Update'
    $cli=& {
        param($body)
        $script:updated=$false
        function New-McpDailyCandidate {param($Root,$Source,$Version) throw 'DAILY_VERSION_EXISTS'}
        function Invoke-McpDailyUpdate {param($Root,$Version,[switch]$CodeOnly) $script:updated=$true}
        $root='fixture';$CandidateRoot='source';$Version='v1';$CodeOnly=$true
        try {& $body|Out-Null}catch{}
        return $script:updated
    } $update
    Check (-not $cli) 'Stage rejection cannot reach Update'
    [pscustomobject]@{ok=$true;passed=$passed;live=$false;processesChanged=$false;startupChanged=$false;aclChanged=$false}|ConvertTo-Json
} finally {
    $resolved=[IO.Path]::GetFullPath($fixture)
    if((Split-Path -Parent $resolved) -ine [IO.Path]::GetTempPath().TrimEnd('\') -or (Split-Path -Leaf $resolved) -cnotmatch '^mcp-daily-fixture-[0-9a-f]{32}$'){throw 'UNSAFE_FIXTURE_CLEANUP'}
    if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
