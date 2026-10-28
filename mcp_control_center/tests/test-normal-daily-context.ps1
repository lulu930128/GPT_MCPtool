Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'src\McpControlCenter.NormalDaily.psm1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'NORMAL_DAILY_PARSE_FAILED'}
# Execute the actual session closure orchestration with inert code manifests.
# No native owner, host listener, live selector or execution capability is used.
foreach($name in @('Assert-McpCcNormalDailyClosure')){
    $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true)
    Invoke-Expression $fn.Extent.Text
}
$script:selected='fixture-a';$script:closureReads=0;$script:bindingChecks=0;$script:reject=$false
function Assert-McpCcNormalDailyBinding($Context){
    $script:bindingChecks++
    if($script:reject){throw 'CC_SELECTION_CHANGED'}
    if($null -ne $Context.bridge -and $Context.bridge.version -cne $script:selected){throw 'DAILY_NORMAL_SELECTION_CHANGED'}
}
function Assert-McpCcDeploymentSelected($Layout){ }
function Read-McpCcNormalDailyBridge($Layout){
    $script:closureReads++
    [pscustomobject]@{version=$script:selected;operatorSid='fixture-sid';root=('fixture/'+$script:selected)}
}
$context=[pscustomobject]@{bridge=$null;operatorSid='fixture-sid';layout=[pscustomobject]@{}}
Assert-McpCcNormalDailyClosure $context
if($context.bridge.version -cne 'fixture-a' -or $script:closureReads -ne 1){throw 'FIRST_SESSION_NOT_RESOLVED'}
$script:selected='fixture-b'
try {Assert-McpCcNormalDailyBinding $context;throw 'MIXED_SESSION_ACCEPTED'}catch{if($_.Exception.Message -cne 'DAILY_NORMAL_SELECTION_CHANGED'){throw}}
# New session discards the stale Bridge pin and resolves the selected generation;
# the retained CC owner is unchanged, with no CC restart requirement.
Assert-McpCcNormalDailyClosure $context
if($context.bridge.version -cne 'fixture-b' -or $script:closureReads -ne 2){throw 'NEW_SESSION_STALE_ROOT'}
$context.operatorSid='other-sid'
try{Assert-McpCcNormalDailyClosure $context;throw 'WRONG_OPERATOR_ACCEPTED'}catch{if($_.Exception.Message -cne 'DAILY_NORMAL_OPERATOR_MISMATCH'){throw}}
$context.operatorSid='fixture-sid';$script:reject=$true;$before=$script:closureReads
try{Assert-McpCcNormalDailyClosure $context;throw 'WRONG_CC_ACCEPTED'}catch{if($_.Exception.Message -cne 'CC_SELECTION_CHANGED'){throw}}
if($script:closureReads -ne $before -or $null -ne $context.bridge){throw 'REJECTED_CC_RESOLVED_BRIDGE'}
[pscustomobject]@{result='PASS';checks=5;deployment='NOT_OPERATED';nativeAuthority='UNVERIFIED'}|ConvertTo-Json -Compress
