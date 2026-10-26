# Isolated filesystem/receipt guards only. Never starts or deletes a real release.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$source=Split-Path -Parent $PSScriptRoot
$daily=Import-Module (Join-Path $source 'src\McpControlCenter.DailyCode.psm1') -PassThru -Force
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $source 'scripts\retire-legacy-releases.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'SCRIPT_PARSE_FAILED'}
foreach($name in @('Read-RetirementJson','Assert-RetirementTarget','Get-RetirementCodeInventory','Read-RetirementAcceptance','Assert-RetirementNoPending')){
    $node=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true)
    . ([scriptblock]::Create($node.Extent.Text))
}
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('retirement-fixture-'+[guid]::NewGuid().ToString('N'))
$checks=0
function Check([bool]$Value,[string]$Name){if(-not $Value){throw ('FAILED: '+$Name)};$script:checks++}
function Denied([scriptblock]$Body,[string]$Code){$actual='';try{& $Body|Out-Null}catch{$actual=$_.Exception.Message};Check ($actual -ceq $Code) ($Code+' actual='+$actual)}
function Put([string]$Path,$Value){[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 5))}
try {
    $root=Join-Path $fixture 'legacy';$release=Join-Path $root 'r1'
    foreach($folder in @('codex_bridge\scripts','mcp_control_center\src','dependencies\node')){[void][IO.Directory]::CreateDirectory((Join-Path $release $folder))}
    [IO.File]::WriteAllText((Join-Path $release 'codex_bridge\scripts\probe.ps1'),'# fixture code')
    Check ((Assert-RetirementTarget $release $root @('r1')) -ceq $release) 'exact reviewed child accepted'
    Denied {Assert-RetirementTarget $root $root @('legacy')} 'RETIREMENT_TARGET_REJECTED'
    Denied {Assert-RetirementTarget (Join-Path $release 'nested') $root @('nested')} 'RETIREMENT_TARGET_REJECTED'
    Denied {Assert-RetirementTarget (Join-Path $root 'maintenance') $root @('r1')} 'RETIREMENT_TARGET_REJECTED'
    $inventory=Get-RetirementCodeInventory $release
    Check ($inventory.files -eq 1 -and $inventory.bytes -gt 0) 'metadata inventory counts code'
    foreach($relative in @('codex_bridge\.env','codex_bridge\credential.dpapi','codex_bridge\data\fixture.txt')){
        $path=Join-Path $release $relative
        [void][IO.Directory]::CreateDirectory((Split-Path -Parent $path))
        [IO.File]::WriteAllText($path,'synthetic fixture')
        Denied {Get-RetirementCodeInventory $release} 'RETIREMENT_PRIVATE_STATE_PRESENT'
        Remove-Item -LiteralPath $path
        if($relative -like '*\data\*'){Remove-Item -LiteralPath (Split-Path -Parent $path)}
    }
    $outside=Join-Path $fixture 'outside';[void][IO.Directory]::CreateDirectory($outside)
    $junction=Join-Path $root 'junction'
    $null=New-Item -ItemType Junction -Path $junction -Target $outside
    Denied {Assert-RetirementTarget $junction $root @('junction')} 'DAILY_REPARSE_REJECTED'
    Remove-Item -LiteralPath $junction
    $runtime=Join-Path $fixture 'Runtime';$acceptance=Join-Path $runtime 'acceptance'
    [void][IO.Directory]::CreateDirectory($acceptance)
    $receipt=Join-Path $acceptance ('manual-start-'+[guid]::NewGuid().ToString('N')+'.json')
    $accepted=@{contract='mcpcc-manual-start-acceptance-v1';phase='ACCEPTED';authenticatedMcp='initialize PASS';anonymousMcp=401;bridgeOwnerStatus='OwnedReady';tunnelOwnerStatus='OwnedReady';ccBridgeProbe='Ready'}
    Put $receipt $accepted
    Check ((Read-RetirementAcceptance $receipt $runtime).phase -ceq 'ACCEPTED') 'manual-start receipt accepted'
    Denied {Read-RetirementAcceptance (Join-Path $fixture (Split-Path -Leaf $receipt)) $runtime} 'RETIREMENT_RECEIPT_PATH_REJECTED'
    $accepted.phase='UNKNOWN';Put $receipt $accepted
    Denied {Read-RetirementAcceptance $receipt $runtime} 'RETIREMENT_ACCEPTANCE_REQUIRED'
    $accepted.phase='ACCEPTED';$accepted.anonymousMcp=200;Put $receipt $accepted
    Denied {Read-RetirementAcceptance $receipt $runtime} 'RETIREMENT_ACCEPTANCE_REQUIRED'
    $attempts=Join-Path $runtime 'retirements'
    Assert-RetirementNoPending $attempts;Check $true 'absent retirement history accepted'
    $attempt=Join-Path $attempts ('legacy-'+[guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($attempt)
    Denied {Assert-RetirementNoPending $attempts} 'RETIREMENT_PENDING_UNKNOWN_DO_NOT_RETRY'
    Put (Join-Path $attempt 'terminal.json') @{phase='UNKNOWN';deleted=@('r1')}
    Denied {Assert-RetirementNoPending $attempts} 'RETIREMENT_PENDING_UNKNOWN_DO_NOT_RETRY'
    Put (Join-Path $attempt 'terminal.json') @{phase='RETIRED'}
    Assert-RetirementNoPending $attempts;Check $true 'completed retirement accepted'
    [pscustomobject]@{ok=$true;checks=$checks;productionDeleted=$false;runtimeChanged=$false}|ConvertTo-Json
} finally {
    if(Test-Path -LiteralPath $fixture){
        $resolved=(Resolve-Path -LiteralPath $fixture).Path
        if((Split-Path -Parent $resolved) -ine [IO.Path]::GetTempPath().TrimEnd('\') -or (Split-Path -Leaf $resolved) -cnotmatch '^retirement-fixture-[0-9a-f]{32}$'){throw 'FIXTURE_CLEANUP_REJECTED'}
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
