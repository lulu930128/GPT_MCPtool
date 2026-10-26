# Offline transaction and byte-scope tests. Never invoke the maintenance entrypoint.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$entry=Join-Path $repo 'codex_bridge\scripts\repair-legacy-tunnel-verifier.ps1'
$utf8=New-Object Text.UTF8Encoding($false,$true)
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($entry,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'PARSE_FAILED'}
foreach($name in @('Get-RepairHash','New-RepairedModuleBytes','New-RepairedManifestBytes','Write-RepairNew','Write-RepairExisting','Invoke-LegacyRepairTransaction')){
    $node=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true)
    . ([scriptblock]::Create($node.Extent.Text))
}
$checks=0
function Check([bool]$Value,[string]$Name){if(-not $Value){throw $Name};$script:checks++}
function Refused([scriptblock]$Body,[string]$Code){$message='';try{& $Body|Out-Null}catch{$message=$_.Exception.Message};Check ($message -ceq $Code) ('Expected '+$Code+'; got '+$message)}
$old=@'
function Test-Fixture {
    $command=if($Role -eq 'server'){'"'+$Context.nodePath+'" "'+$Context.httpEntry+'"'}else{'"'+$Context.tunnelClientPath+'" run --profile-dir "'+$Context.tunnelProfileDir+'" --profile "codex-bridge" --log.file "'+$Context.tunnelLogFile+'" --pid.file "'+$Context.tunnelPidFile+'"'}
}
'@
foreach($prefix in @('',[string][char]0xfeff)){
    foreach($ending in @("`n","`r`n")){
        $before=$prefix+($old -replace '\r?\n',$ending)
        $patched=$utf8.GetString((New-RepairedModuleBytes $utf8.GetBytes($before)))
        Check ($patched.Contains('Get-CbTunnelArguments $Context')) 'uses existing argument builder'
        Check ($patched.StartsWith($prefix+'function Test-Fixture')) 'preserves BOM'
        $a=$before.Split([char]10);$b=$patched.Split([char]10)
        Check ($a.Count -eq $b.Count -and $a[0] -ceq $b[0] -and $a[2] -ceq $b[2]) 'preserves all other source lines'
        Refused {New-RepairedModuleBytes $utf8.GetBytes($patched)} 'LEGACY_REPAIR_SOURCE_CHANGED'
    }
}
Refused {New-RepairedModuleBytes $utf8.GetBytes($old+$old)} 'LEGACY_REPAIR_SOURCE_CHANGED'
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('legacy-verifier-fixture-'+[guid]::NewGuid().ToString('N'))
try {
    foreach($scenario in @('success','verification-failure','external-change')){
        $dir=Join-Path $fixture $scenario;[void][IO.Directory]::CreateDirectory($dir)
        $modulePath=Join-Path $dir 'runtime.psm1';$manifestPath=Join-Path $dir 'manifest.json';$backupDir=Join-Path $dir 'backup'
        [void][IO.Directory]::CreateDirectory($backupDir)
        [IO.File]::WriteAllText($modulePath,$old,$utf8)
        $modulePin=Get-RepairHash ([IO.File]::ReadAllBytes($modulePath))
        $manifest='{"treeHashes":{"codex_bridge":"'+$modulePin+'","dependencies":"'+('1'*64)+'"},"state":{"fixture":"unchanged"}}'
        [IO.File]::WriteAllText($manifestPath,$manifest,$utf8)
        $manifestPin=Get-RepairHash ([IO.File]::ReadAllBytes($manifestPath))
        $failOnce=$scenario -eq 'verification-failure'
        function Get-LegacyRepairBridgeHash {
            if($scenario -eq 'external-change'){[IO.File]::WriteAllText($modulePath,'foreign change',$utf8);throw 'FIXTURE_FOREIGN_CHANGE'}
            return Get-RepairHash ([IO.File]::ReadAllBytes($modulePath))
        }
        function Assert-LegacyRepairClosure {
            if($script:failOnce){$script:failOnce=$false;throw 'FIXTURE_VERIFY_FAILED'}
            $doc=Get-Content -LiteralPath $manifestPath -Raw|ConvertFrom-Json
            if($doc.treeHashes.codex_bridge -cne (Get-RepairHash ([IO.File]::ReadAllBytes($modulePath)))){throw 'FIXTURE_CLOSURE_FAILED'}
        }
        $script:failOnce=$failOnce
        if($scenario -eq 'success'){
            $result=Invoke-LegacyRepairTransaction $modulePath $manifestPath $backupDir
            Check ($result.phase -ceq 'REPAIRED' -and -not $result.aclChanged -and -not $result.runtimeRestarted) 'successful bounded repair'
            $document=Get-Content -LiteralPath $manifestPath -Raw|ConvertFrom-Json
            Check ($document.treeHashes.dependencies -ceq ('1'*64) -and $document.state.fixture -ceq 'unchanged') 'non-code manifest fields preserved'
        }elseif($scenario -eq 'verification-failure'){
            Refused {Invoke-LegacyRepairTransaction $modulePath $manifestPath $backupDir} 'LEGACY_REPAIR_ROLLED_BACK_INSPECT_BACKUP'
            Check ((Get-RepairHash ([IO.File]::ReadAllBytes($modulePath))) -ceq $modulePin -and (Get-RepairHash ([IO.File]::ReadAllBytes($manifestPath))) -ceq $manifestPin) 'known failure restores exact original bytes'
        }else{
            Refused {Invoke-LegacyRepairTransaction $modulePath $manifestPath $backupDir} 'LEGACY_REPAIR_UNKNOWN_DO_NOT_RETRY'
            Check ([IO.File]::ReadAllText($modulePath) -ceq 'foreign change') 'external mutation is not overwritten'
        }
        Check ((Get-RepairHash ([IO.File]::ReadAllBytes((Join-Path $backupDir 'codex-bridge-runtime.before.psm1')))) -ceq $modulePin) 'module backup is byte exact'
        Check ((Get-RepairHash ([IO.File]::ReadAllBytes((Join-Path $backupDir 'installed-release.before.json')))) -ceq $manifestPin) 'manifest backup is byte exact'
    }
}finally{
    $resolved=[IO.Path]::GetFullPath($fixture)
    if((Split-Path -Parent $resolved) -ine [IO.Path]::GetTempPath().TrimEnd('\') -or (Split-Path -Leaf $resolved) -cnotmatch '^legacy-verifier-fixture-[0-9a-f]{32}$'){throw 'FIXTURE_SCOPE_REJECTED'}
    if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
@{ok=$true;checks=$checks;productionTouched=$false;runtimeStarted=$false;aclChanged=$false}|ConvertTo-Json
