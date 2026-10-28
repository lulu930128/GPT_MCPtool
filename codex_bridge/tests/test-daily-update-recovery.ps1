# Isolated state-machine integration. No production Runtime or controller calls.
param([switch]$RedBaseline)
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$module=Import-Module (Join-Path $repo 'mcp_control_center\src\McpControlCenter.DailyCode.psm1') -Force -PassThru
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('mcp-daily-recovery-'+[guid]::NewGuid().ToString('N'))
$passed=0
function Check([bool]$Value,[string]$Name){if(-not $Value){throw "FAILED: $Name"};$script:passed++}
function Put([string]$Path,[string]$Text){[void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path));[IO.File]::WriteAllText($Path,$Text)}
# Reuse only the existing synthetic candidate builder, never run the old test body.
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'test-daily-code-update.ps1'),[ref]$tokens,[ref]$errors)
$builder=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'New-Case'},$true)
. ([scriptblock]::Create($builder.Extent.Text))
function Set-Fixture([string]$Root,[string]$Scenario='normal',[string]$Running='v1'){
    & $module {param($r,$s,$running)
        $script:Scenario=$s;$script:Running=$running;$script:Calls=New-Object 'Collections.Generic.List[string]'
        function script:Invoke-DailyOwner {
            param($Root,$Version,$Action)
            $script:Calls.Add($Version+':'+$Action)
            switch($Action){
                Observe {
                    $state=if(-not $script:Running){'Stopped'}elseif($script:Running -ceq $Version){'OwnedReady'}else{'OwnershipMismatch'}
                    return @{version=$Version;buildId=$Version;coreReady=($script:Running -ceq $Version -and -not($script:Scenario -eq 'unhealthy-target' -and $Version -eq 'v2'));
                        roles=@{server=@{state=$state;canMutate=($state -ne 'OwnershipMismatch')};tunnel=@{state=$state;canMutate=($state -ne 'OwnershipMismatch')}}}
                }
                Stop {
                    if($script:Scenario -eq 'active'){throw 'ACTIVE_WORK_PRESENT'}
                    if($script:Running -and $script:Running -cne $Version){throw 'OWNERSHIP_MISMATCH'}
                    $script:Running=''
                    if($script:Scenario -eq 'old-lock'){throw 'DAILY_STATE_LOCK_PRESENT'}
                }
                RecoverStopped {if($script:Running){throw 'CORE_STILL_ALIVE'};return @{phase='STOPPED';serverExited=$true;tunnelExited=$true}}
                Stopped {if($script:Running){throw 'CORE_STILL_ALIVE'}}
                Start {$script:Running=$Version;if($script:Scenario -eq 'start-fail' -and $Version -eq 'v2'){throw 'SERVER_START_FAILED'}}
                Verify {
                    if($script:Running -cne $Version){throw 'DAILY_READINESS_FAILED'}
                    if($script:Scenario -eq 'store-fault' -or ($script:Scenario -eq 'verify-fail' -and $Version -eq 'v2')){throw 'DAILY_REVIEW_STORE_NOT_READY'}
                    return @{version=$Version;buildId=$Version;reviewStore=@{startup=@{status='OPEN'};current=@{owner='THIS_INSTANCE'}}}
                }
            }
        }
    } $Root $Scenario $Running
}
function New-Pending($Case,[string]$Selected='v1'){
    $id=[guid]::NewGuid().ToString('N')
    Put (Join-Path $Case.root ('operations/'+$id+'/intent.json')) '{"old":"v1","next":"v2","changed":[],"createdUtc":"2026-10-28T00:00:00Z"}'
    & $module {param($r,$v) Set-DailySelector $r $v} $Case.root $Selected
    return $id
}
function Calls {return @(& $module {$script:Calls.ToArray()})}
try {
    $case=New-Case history
    if(-not $RedBaseline){Set-Fixture $case.root}
    $operation='11111111111111111111111111111111'
    Put (Join-Path $case.root ('operations/'+$operation+'/intent.json')) '{"old":"v1","next":"v2","changed":[],"createdUtc":"2026-10-28T00:00:00Z"}'
    Put (Join-Path $case.root ('operations/'+$operation+'/failure.json')) '{"phase":"STOPPING","code":"DAILY_STATE_LOCK_PRESENT"}'
    # The original defect is reached through the public Update API, not text matching.
    $result=Invoke-McpDailyUpdate -Root $case.root -Version v2 -CodeOnly
    Check ($result.phase -eq 'ACCEPTED') 'historical missing terminal no longer permanently blocks Update'
    $prior=Get-McpDailyOperationStatus $case.root $operation
    Check ($prior.result.phase -eq 'NOT_APPLIED') 'healthy original version closes old pending before next update'
    Check ((Get-Content -Raw (Join-Path $case.root ('operations/'+$operation+'/failure.json'))) -ceq '{"phase":"STOPPING","code":"DAILY_STATE_LOCK_PRESENT"}') 'historical failure bytes preserved'

    $case=New-Case bootstrap;Set-Fixture $case.root old-lock
    $result=Invoke-McpDailyUpdate -Root $case.root -Version v2 -CodeOnly
    Check ($result.phase -eq 'ACCEPTED') 'old owner error after actual exit reaches source recovery'
    Check ((Calls) -contains 'v1:RecoverStopped') 'source recovery invoked for first upgrade'
    Check ((Calls) -contains 'v1:Stop') 'old owner still receives normal Stop'

    foreach($point in @('after-stop','after-selector','ready-without-terminal')){
        $case=New-Case $point;$selected=if($point -eq 'after-stop'){'v1'}else{'v2'}
        $id=New-Pending $case $selected
        $running=if($point -eq 'ready-without-terminal'){'v2'}else{''}
        Set-Fixture $case.root normal $running
        $before=Get-FileHash (Join-Path $case.root ('operations/'+$id+'/intent.json'))
        $status=Get-McpDailyOperationStatus $case.root $id
        Check ($status.recoveryRequired) ($point+' read-only status reports recovery')
        Check (-not(Test-Path (Join-Path $case.root 'update.lock'))) 'Status never creates update.lock'
        $result=Repair-McpDailyOperation $case.root $id
        Check ($result.phase -eq 'ACCEPTED' -and $result.operationId -eq $id) ($point+' resumes same operation')
        Check ((Calls) -notcontains 'v1:Stop') ($point+' completed stop not replayed')
        if($point -eq 'ready-without-terminal'){Check ((Calls) -notcontains 'v2:Start') 'ready runtime not restarted'}
        $count=@(Calls).Count
        Check ((Repair-McpDailyOperation $case.root $id).phase -eq 'ACCEPTED') 'terminal reentry returns receipt'
        Check (@(Calls).Count -eq $count) 'terminal reentry has zero owner calls'
        Check ((Get-FileHash (Join-Path $case.root ('operations/'+$id+'/intent.json'))).Hash -ceq $before.Hash) 'intent preserved byte for byte'
    }
    foreach($partial in @('terminal.json','resolution.json')){
        $case=New-Case ('partial-'+$partial);$id=New-Pending $case v2;Set-Fixture $case.root normal v2
        $path=Join-Path $case.root ('operations/'+$id+'/'+$partial);Put $path '{"phase":'
        $hash=(Get-FileHash $path).Hash
        Check ((Repair-McpDailyOperation $case.root $id).phase -eq 'ACCEPTED') ($partial+' truncated history recovers')
        Check ((Get-FileHash $path).Hash -ceq $hash) ($partial+' original bytes retained')
        Check ((Calls) -notcontains 'v2:Start') 'partial receipt recovery verifies ready target without restart'
        Check (-not(Get-McpDailyOperationStatus $case.root $id).recoveryRequired) 'new immutable resolution closes partial publication'
    }
    $case=New-Case third
    Put (Join-Path $case.source 'codex_bridge/web/index.html') 'third version'
    $null=New-McpDailyCandidate -Root $case.root -Source $case.source -Version v3
    $id=New-Pending $case v3;Set-Fixture $case.root normal v3
    $result=Repair-McpDailyOperation $case.root $id
    Check ($result.phase -eq 'SUPERSEDED' -and $result.selectedVersion -eq 'v3') 'healthy third version never downgraded'
    Check (@((Calls)|Where-Object {$_ -match ':Stop|:Start$'}).Count -eq 0) 'superseded operation never mutates lifecycle'

    foreach($scenario in @('start-fail','verify-fail','store-fault')){
        $case=New-Case $scenario;Set-Fixture $case.root $scenario
        $result=Invoke-McpDailyUpdate -Root $case.root -Version v2 -CodeOnly
        $expected=if($scenario -eq 'store-fault'){'DEGRADED'}else{'ROLLED_BACK'}
        Check ($result.phase -eq $expected -and $result.selectedVersion -eq 'v1') ($scenario+' rollback result honest')
        # Real journal bytes are exercised by daily-store-recovery.test.ts.
        Check (@(& $module {param($r) Get-DailyPending $r} $case.root).Count -eq 0) 'known rollback outcome does not poison later updates'
        Set-Fixture $case.root normal
        Check ((Invoke-McpDailyUpdate -Root $case.root -Version v2 -CodeOnly).phase -eq 'ACCEPTED') 'next update can enter after failure'
    }
    $case=New-Case readonly;$id=New-Pending $case;Set-Fixture $case.root
    $preflight=Test-McpDailyUpdate -Root $case.root -Version v2 -CodeOnly
    Check ($preflight.pendingOperations -contains $id) 'Preflight reports pending instead of permanent rejection'
    Check (-not(Test-Path (Join-Path $case.root 'update.lock'))) 'Preflight remains read-only'
    Check (@(Calls).Count -eq 0) 'Preflight invokes no owner'

    $case=New-Case active;Set-Fixture $case.root active
    $r=Invoke-McpDailyUpdate -Root $case.root -Version v2 -CodeOnly
    Check ($r.phase -eq 'REJECTED' -and $r.selectedVersion -eq 'v1') 'active owner not stopped or recovered'
    Check ((Calls) -notcontains 'v1:RecoverStopped') 'live owner lock never sent to recovery'

    $case=New-Case rollback-resume;$id=New-Pending $case v2
    Put (Join-Path $case.root ('operations/'+$id+'/rollback-intent.json')) '{"code":"DAILY_REVIEW_STORE_NOT_READY"}'
    Set-Fixture $case.root normal v2
    Check ((Repair-McpDailyOperation $case.root $id).phase -eq 'ROLLED_BACK') 'interrupted rollback resumes original direction'

    $case=New-Case unhealthy-target;$id=New-Pending $case v2;Set-Fixture $case.root unhealthy-target v2
    Check ((Repair-McpDailyOperation $case.root $id).phase -eq 'ROLLED_BACK') 'selected unhealthy target recovers to verified old release'
    $case=New-Case lost-candidate;$id=New-Pending $case;Set-Fixture $case.root normal ''
    Put (Join-Path $case.root 'versions/v2/codex_bridge/web/index.html') 'tampered while interrupted'
    Check ((Repair-McpDailyOperation $case.root $id).phase -eq 'ROLLED_BACK') 'unusable candidate after old stop restores old release'

    $case=New-Case build-stage;Set-Fixture $case.root
    & $module {function script:Build-DailyCandidate {param($Source) $script:Calls.Add('Build');throw 'DAILY_BUILD_FAILED'}}
    $code='';try {Invoke-McpDailyUpdate -Root $case.root -Version v2 -CodeOnly -CandidateRoot $case.source|Out-Null}catch{$code=$_.Exception.Message}
    Check ($code -eq 'DAILY_BUILD_FAILED' -and (Calls) -notcontains 'v1:Stop') 'Build failure precedes stop'
    & $module {function script:Build-DailyCandidate {param($Source) $script:Calls.Add('Build')}}
    Put (Join-Path $case.source 'codex_bridge/web/index.html') 'changed immutable identity'
    $code='';try {Invoke-McpDailyUpdate -Root $case.root -Version v2 -CodeOnly -CandidateRoot $case.source|Out-Null}catch{$code=$_.Exception.Message}
    Check ($code -eq 'DAILY_VERSION_CONTENT_CHANGED_USE_NEW_ID' -and (Calls) -notcontains 'v1:Stop') 'Stage content mismatch preserves healthy old service'
    $r=Invoke-McpDailyUpdate -Root $case.root -Version v3 -CodeOnly -CandidateRoot $case.source
    Check ($r.phase -eq 'ACCEPTED') 'single Update builds stages and updates'
    $r=Invoke-McpDailyUpdate -Root $case.root -Version v3 -CodeOnly -CandidateRoot $case.source
    Check ($r.phase -eq 'ALREADY_SELECTED') 'same candidate can be reentered without overwriting release'

    $case=New-Case source-during-build;Set-Fixture $case.root
    $requestId=[guid]::NewGuid().ToString('N')
    & $module {
        $script:FixtureSourcePin='a'*64
        function script:Get-DailySourcePin {param($Source) return $script:FixtureSourcePin}
        function script:Build-DailyCandidate {param($Source) $script:Calls.Add('Build');$script:FixtureSourcePin='b'*64}
    }
    $code='';try{Invoke-McpDailyUpdate -Root $case.root -Version v3 -CodeOnly -CandidateRoot $case.source -OperationId $requestId -SourceDigest ('a'*64)|Out-Null}catch{$code=$_.Exception.Message}
    Check ($code -ceq 'SOURCE_CHANGED_USE_NEW_REQUEST') 'source changed during build rejects original request'
    Check ((Calls) -notcontains 'v1:Stop' -and (Get-McpDailyStatus $case.root).version -eq 'v1') 'drift never stops old service or selects new code'
    $request=Get-Content -LiteralPath (Join-Path $case.root ('operations/'+$requestId+'/request.json')) -Raw|ConvertFrom-Json
    Check ($request.sourceDigest -ceq ('a'*64)) 'drift preserves original operation admission pin'

    $entryAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'codex_bridge/scripts/daily-code-update.ps1'),[ref]$tokens,[ref]$errors)
    $switch=$entryAst.Find({param($n) $n -is [Management.Automation.Language.SwitchStatementAst]},$true)
    $text=@($switch.Clauses|Where-Object {$_.Item1.Value -ceq 'Start'})[0].Item2.Extent.Text
    $cli=Join-Path $fixture 'start-cli.ps1'
    Put $cli ('function Start-McpDailyCurrent {param($Root) return @{phase="RECOVERY_REQUIRED"}}' + "`n" + '$root="fixture"' + "`n" + $text.Substring(1,$text.Length-2))
    $null=& (Join-Path $PSHOME 'powershell.exe') -NoProfile -File $cli
    Check ($LASTEXITCODE -ne 0) 'actual Start CLI returns nonzero for recovery-required result'
    [pscustomobject]@{ok=$true;passed=$passed;live=$false}|ConvertTo-Json
} finally {
    $resolved=[IO.Path]::GetFullPath($fixture)
    if((Split-Path -Parent $resolved) -ine [IO.Path]::GetTempPath().TrimEnd('\') -or (Split-Path -Leaf $resolved) -cnotmatch '^mcp-daily-recovery-[0-9a-f]{32}$'){throw 'UNSAFE_FIXTURE_CLEANUP'}
    if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
