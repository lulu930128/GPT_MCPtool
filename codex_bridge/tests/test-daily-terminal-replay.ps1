# Isolated canonical engine regression; no production selector or owner calls.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$module=Import-Module (Join-Path $repo 'mcp_control_center/src/McpControlCenter.DailyCode.psm1') -Force -PassThru
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('daily-terminal-'+[guid]::NewGuid().ToString('N'))
$passed=0
& $module {
    $script:OriginalSelector=${function:Set-DailySelector}
    $script:SelectCalls=New-Object 'Collections.Generic.List[string]'
    function script:Set-DailySelector {param($Root,$Version) $script:SelectCalls.Add($Version);& $script:OriginalSelector $Root $Version}
}
function Check([bool]$Value,[string]$Name){if(-not $Value){throw "FAILED: $Name"};$script:passed++}
function Put([string]$Path,[string]$Text){[void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path));[IO.File]::WriteAllText($Path,$Text)}
function Denied([scriptblock]$Body,[string]$Code){$message='';try{& $Body|Out-Null}catch{$message=$_.Exception.Message};Check ($message -eq $Code) ($Code+' observed='+$message)}
foreach($entry in @(@('test-daily-code-update.ps1','New-Case'),@('test-daily-update-recovery.ps1','Set-Fixture'))){
    $tokens=$null;$errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $entry[0]),[ref]$tokens,[ref]$errors)
    $name=$entry[1]
    $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true)
    . ([scriptblock]::Create($fn.Extent.Text))
}
function Configure($Case,[string]$Scenario='normal'){
    Set-Fixture $Case.root $Scenario
    & $module {
        $script:FixtureDigest='a'*64
        $script:SelectCalls.Clear()
        function script:Get-DailySourcePin {param($Source) return $script:FixtureDigest}
        function script:Build-DailyCandidate {param($Source) $script:Calls.Add('Build')}
    }
}
function Calls {return @(& $module {$script:Calls.ToArray()})}
function Reserve($Case,[string]$Id,[string]$Version){
    Put (Join-Path $Case.root ('operations/'+$Id+'/request.json')) (@{operationId=$Id;version=$Version;sourceDigest=('a'*64);createdUtc='2026-10-28T00:00:00Z'}|ConvertTo-Json)
}
try {
    $case=New-Case nochange;Configure $case
    Put (Join-Path $case.source 'codex_bridge/web/index.html') 'fixture code v1'
    $id=[guid]::NewGuid().ToString('N')
    $result=Invoke-McpDailyUpdate -Root $case.root -Version v3 -CodeOnly -CandidateRoot $case.source -OperationId $id -SourceDigest ('a'*64)
    Check ($result.phase -eq 'NOT_APPLIED' -and $result.code -eq 'DAILY_NO_CODE_CHANGE') 'equivalent staged code is a canonical terminal no-op'
    Check ($result.requestedVersion -eq 'v3' -and $result.selectedVersion -eq 'v1' -and $result.observedRuntimeVersion -eq 'v1') 'requested and actual versions remain distinct'
    Check ((Calls) -contains 'Build' -and (Calls) -contains 'v1:Verify') 'no-op follows preparation and verifies existing owner'
    Check (@((Calls)|Where-Object {$_ -match ':(Stop|Start|Preflight)$'}).Count -eq 0) 'no lifecycle mutation for no-change'
    Check (-not(Test-Path (Join-Path $case.root ('operations/'+$id+'/intent.json')))) 'no mutation intent published'
    $terminal=Join-Path $case.root ('operations/'+$id+'/terminal.json');$hash=(Get-FileHash $terminal).Hash
    Put (Join-Path $case.source 'codex_bridge/web/index.html') 'subsequent source edit'
    & $module {$script:Calls.Clear();$script:FixtureDigest='b'*64}
    $again=Invoke-McpDailyUpdate -Root $case.root -Version v3 -CodeOnly -CandidateRoot $case.source -OperationId $id -SourceDigest ('a'*64)
    Check ($again.phase -eq 'NOT_APPLIED' -and @(Calls).Count -eq 0) 'terminal replay precedes source/build/owner checks'
    Check ((Get-FileHash $terminal).Hash -eq $hash) 'terminal bytes preserved'
    Check ((& $module {$script:SelectCalls.Count}) -eq 0) 'no-op and terminal replay never call real selector writer'
    Denied {Invoke-McpDailyUpdate -Root $case.root -Version v4 -CodeOnly -OperationId $id -SourceDigest ('a'*64)} 'DAILY_REQUEST_CONFLICT'
    Denied {Invoke-McpDailyUpdate -Root $case.root -Version v3 -CodeOnly -OperationId $id -SourceDigest ('b'*64)} 'DAILY_REQUEST_CONFLICT'
    Denied {Repair-McpDailyOperation -Root $case.root -OperationId $id -Version v3 -SourceDigest ('b'*64)} 'DAILY_REQUEST_CONFLICT'
    Denied {Repair-McpDailyOperation -Root $case.root -OperationId $id -Version v4 -SourceDigest ('a'*64)} 'DAILY_REQUEST_CONFLICT'

    $legacy=New-Case legacy;Configure $legacy
    Put (Join-Path $legacy.source 'codex_bridge/web/index.html') 'fixture code v1'
    $null=New-McpDailyCandidate -Root $legacy.root -Source $legacy.source -Version original-request
    $oldId=[guid]::NewGuid().ToString('N');Reserve $legacy $oldId original-request
    Put (Join-Path $legacy.source 'codex_bridge/web/index.html') 'new editable code'
    & $module {$script:FixtureDigest='b'*64}
    $recovered=Repair-McpDailyOperation -Root $legacy.root -OperationId $oldId -Version original-request -SourceDigest ('a'*64)
    Check ($recovered.phase -eq 'NOT_APPLIED' -and $recovered.code -eq 'DAILY_NO_CODE_CHANGE') 'legacy request-only failure closes through original operation'
    Check ($recovered.requestedVersion -eq 'original-request' -and $recovered.selectedVersion -eq 'v1') 'no-intent recovery retains request version'
    Check (((Calls) -join ',') -eq 'v1:Verify') 'legacy recovery only observes original immutable artifact and owner'

    $empty=New-Case empty-directory;Configure $empty
    $emptyId=[guid]::NewGuid().ToString('N')
    [void][IO.Directory]::CreateDirectory((Join-Path $empty.root ('operations/'+$emptyId)))
    $emptyResult=Repair-McpDailyOperation -Root $empty.root -OperationId $emptyId
    Check ($emptyResult.phase -eq 'NOT_APPLIED' -and $emptyResult.code -eq 'DAILY_INTENT_NOT_PUBLISHED') 'directory-before-request crash safely terminates'
    Check ($emptyResult.requestedVersion -eq '' -and $emptyResult.selectedVersion -eq 'v1') 'absent request never invents requested version'
    Check (((Calls) -join ',') -eq 'v1:Verify') 'empty reservation only verifies selected owner'
    $missingRequestError='';try{Repair-McpDailyOperation -Root $empty.root -OperationId $emptyId -Version v2 -SourceDigest ('a'*64)|Out-Null}catch{$missingRequestError=$_.Exception.Message}
    Check ([bool]$missingRequestError) 'remote parameter-bound recovery still requires request even after terminal'
    $emptyTerminal=Join-Path $empty.root ('operations/'+$emptyId+'/terminal.json');$emptyHash=(Get-FileHash $emptyTerminal).Hash
    Denied {Invoke-McpDailyUpdate -Root $empty.root -Version v2 -CodeOnly -OperationId $emptyId -SourceDigest ('a'*64)} 'DAILY_REQUEST_BINDING_MISSING'
    Check (-not(Test-Path (Join-Path $empty.root ('operations/'+$emptyId+'/request.json')))) 'terminal without request cannot acquire a new binding'
    Check ((Get-FileHash $emptyTerminal).Hash -eq $emptyHash) 'unbound replay rejection preserves original terminal bytes'
    $next=Invoke-McpDailyUpdate -Root $empty.root -Version v2 -CodeOnly
    Check ($next.phase -eq 'ACCEPTED') 'empty crash directory no longer blocks later update'

    $fault=New-Case fault;Configure $fault store-fault
    Put (Join-Path $fault.source 'codex_bridge/web/index.html') 'fixture code v1'
    $null=New-McpDailyCandidate -Root $fault.root -Source $fault.source -Version same-code
    $faultId=[guid]::NewGuid().ToString('N');Reserve $fault $faultId same-code
    $bad=Repair-McpDailyOperation -Root $fault.root -OperationId $faultId -Version same-code -SourceDigest ('a'*64)
    Check ($bad.phase -eq 'RECOVERY_REQUIRED' -and $bad.code -eq 'DAILY_REVIEW_STORE_NOT_READY') 'owner failure never becomes successful no-op'
    Set-Fixture $fault.root
    $healed=Repair-McpDailyOperation -Root $fault.root -OperationId $faultId -Version same-code -SourceDigest ('a'*64)
    Check ($healed.phase -eq 'NOT_APPLIED' -and $healed.code -eq 'DAILY_NO_CODE_CHANGE') 'same operation converges when original owner becomes verifiable'
    Check (((Calls) -join ',') -eq 'v1:Verify' -and (& $module {$script:SelectCalls.Count}) -eq 0) 'owner recovery does not rebuild stop or select'

    $changed=New-Case changed;Configure $changed
    $changedId=[guid]::NewGuid().ToString('N')
    $accepted=Invoke-McpDailyUpdate -Root $changed.root -Version v2 -CodeOnly -CandidateRoot $changed.source -OperationId $changedId -SourceDigest ('a'*64)
    Check ($accepted.phase -eq 'ACCEPTED' -and $accepted.observedRuntimeVersion -eq 'v2') 'changed code still adopts and verifies loaded version'
    $mutatingFlow=@((Calls)|Where-Object {$_ -notlike '*:Observe'})
    Check (($mutatingFlow -join ',') -eq 'Build,v2:Preflight,v1:Stop,v1:RecoverStopped,v1:Stopped,v2:Start,v2:Verify') 'changed code retains ordered exactly-once owner flow, allowing readonly Observe'
    Check ((Get-McpDailyStatus $changed.root).version -eq 'v2') 'changed code selects requested immutable version'
    $intent=Get-Content -Raw -Encoding UTF8 (Join-Path $changed.root ('operations/'+$changedId+'/intent.json'))|ConvertFrom-Json
    $terminalResult=Get-Content -Raw -Encoding UTF8 (Join-Path $changed.root ('operations/'+$changedId+'/terminal.json'))|ConvertFrom-Json
    Check ($intent.old -eq 'v1' -and $intent.next -eq 'v2' -and $terminalResult.phase -eq 'ACCEPTED' -and $terminalResult.operationId -eq $changedId) 'intent and terminal retain exact canonical transition'
    & $module {$script:Calls.Clear()}
    $selectorCalls=& $module {$script:SelectCalls.Count}
    $same=Invoke-McpDailyUpdate -Root $changed.root -Version v2 -CodeOnly -CandidateRoot $changed.source -OperationId $changedId -SourceDigest ('a'*64)
    Check ($same.phase -eq 'ACCEPTED' -and @(Calls).Count -eq 0) 'accepted replay never rebuilds or selects'
    Check ((& $module {$script:SelectCalls.Count}) -eq $selectorCalls -and $selectorCalls -eq 1) 'exact real selector writer invoked once across update and replay'
    Write-Output ('PASS daily terminal replay: '+$passed+' checks')
}finally{Write-Output ('Fixture retained: '+$fixture)}
