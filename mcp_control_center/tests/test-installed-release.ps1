Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$source=Split-Path -Parent $PSScriptRoot
$tempBase=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$fixture=Join-Path $tempBase ('mcpcc-installed-'+[guid]::NewGuid().ToString('N'))
$utf8=New-Object Text.UTF8Encoding($false);$passed=0
function Check([bool]$Value,[string]$Message) {if(-not $Value){throw $Message};$script:passed++}
function Denied([scriptblock]$Action,[string]$Pattern) {
    $errorText='';try {& $Action | Out-Null}catch{$errorText=$_.Exception.Message}
    Check ($errorText -match $Pattern) "Expected $Pattern; actual: $errorText"
}
function Write-Json([string]$Path,$Value){[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 30),$utf8)}
$folders=[ordered]@{project_reading='project_reading';omi_search='OMI_search';japanese_study='japanese_study';memory_core='Memory Core';codex_bridge='codex_bridge';personal_asset_os='personal-asset-os';english_study='english_study';listening_audio='listening_audio'}
try {
    $legacy=Join-Path $fixture 'legacy';$releaseRoot=Join-Path $fixture 'release-a';$manager=Join-Path $releaseRoot 'mcp_control_center'
    New-Item -ItemType Directory -Force -Path (Join-Path $manager 'src'),(Join-Path $manager 'config'),(Join-Path $manager 'scripts'),(Join-Path $legacy 'mcp_control_center\config') | Out-Null
    foreach($name in @('control-center.ps1','tray.ps1')){Copy-Item -LiteralPath (Join-Path $source "scripts\$name") -Destination (Join-Path $manager "scripts\$name")}
    foreach($name in @('McpControlCenter.Core.psm1','McpControlCenter.InstalledRelease.psm1')){
        Copy-Item -LiteralPath (Join-Path $source "src\$name") -Destination (Join-Path $manager "src\$name")
    }
    $registry=Get-Content -LiteralPath (Join-Path $source 'config\registry.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $descriptorSource=Get-Content -LiteralPath (Join-Path (Split-Path -Parent $source) 'codex_bridge\control-center\component.json') -Raw -Encoding UTF8
    $index=0
    foreach($id in $folders.Keys){
        foreach($parent in @($legacy,$releaseRoot) | Select-Object -Unique){
            if ($parent -eq $releaseRoot -and $id -ne 'codex_bridge') {continue}
            $root=Join-Path $parent $folders[$id]
            New-Item -ItemType Directory -Force -Path (Join-Path $root 'control-center'),(Join-Path $root 'scripts') | Out-Null
            $descriptor=$descriptorSource|ConvertFrom-Json;$descriptor.id=$id
            $descriptor.probes[0].port=21000+$index*2;$descriptor.probes[0].url="http://127.0.0.1:$($descriptor.probes[0].port)/health"
            $descriptor.probes[1].port=21001+$index*2;$descriptor.probes[1].url="http://127.0.0.1:$($descriptor.probes[1].port)/readyz"
            Write-Json (Join-Path $root 'control-center\component.json') $descriptor
            foreach($name in @('runtime-control.ps1','control-center-ui.ps1','show-diagnostic-tray.vbs','start-tray.vbs')) {
                [IO.File]::WriteAllText((Join-Path $root "scripts\$name"),'throw "FIXTURE_MUST_NOT_EXECUTE"',$utf8)
            }
        };$index++
    }
    $core=Import-Module (Join-Path $manager 'src\McpControlCenter.Core.psm1') -Force -PassThru
    $v3Path=Join-Path $legacy 'mcp_control_center\config\registry.json';Write-Json $v3Path $registry
    $v3=Read-McpCcManifest -Path $v3Path
    Check ($v3.schemaVersion -eq 3 -and $v3.registeredCount -eq 8 -and $null -eq $v3.PSObject.Properties['installedRelease']) 'Legacy v3 output shape preserved'
    foreach($entry in $v3.registryEntries){Check ($entry.resolvedRoot -eq (Join-Path $legacy $folders[$entry.id])) ('Legacy root: '+$entry.id)}
    $registry.schemaVersion=4;foreach($entry in $registry.components){$entry.root=$entry.id}
    $v4Path=Join-Path $manager 'config\registry.json';Write-Json $v4Path $registry
    $releasePath=Join-Path $manager 'config\installed-release.json'
    $releaseDocument=[pscustomobject]@{contract='mcpcc-installed-release-v1';schemaVersion=1;releaseId='release-a';legacyWorkspaceRoot=$legacy;
        dependencies=[pscustomobject]@{node=('a'*64);tunnelClient=('b'*64);keyStore=('c'*64)}}
    Write-Json $releasePath $releaseDocument
    $v4=Read-McpCcManifest -Path $v4Path
    Check ($v4.schemaVersion -eq 4 -and $v4.registeredCount -eq 8) 'Opt-in maps exactly eight components'
    foreach($entry in $v4.registryEntries){
        $expected=Join-Path $(if($entry.id -eq 'codex_bridge'){$releaseRoot}else{$legacy}) $folders[$entry.id]
        Check ($entry.resolvedRoot -eq $expected) ('Installed mapping: '+$entry.id)
    }
    Denied {Invoke-McpCcComponentAction -Manifest $v4 -ComponentId codex_bridge -Action reload_runtime -RuntimeRoot (Join-Path $fixture 'unused')} 'INSTALLED_LIFECYCLE_BINDINGS_REQUIRED'
    Denied {Invoke-McpCcComponentUiAction -Manifest $v4 -ComponentId codex_bridge -ActionId copy_mcp_url -RuntimeRoot (Join-Path $fixture 'unused')} 'INSTALLED_LIFECYCLE_BINDINGS_REQUIRED'
    Check (-not (Test-Path -LiteralPath (Join-Path $fixture 'unused'))) 'No runtime state or controller created on blocked activation'
    $blockedCalls=& $core {
        param($m,$runtime)
        $script:launches=0;$rejections=0
        function script:Invoke-McpCcBoundedPowerShell {$script:launches++;throw 'UNEXPECTED_LAUNCH'}
        function script:Start-Process {$script:launches++;throw 'UNEXPECTED_LAUNCH'}
        foreach($component in $m.components){
            foreach($action in @('start','restart','ensure_running','repair_connectivity','restart_core','reload_runtime','shutdown_runtime','show_diagnostic_tray')){
                try{Invoke-McpCcComponentAction -Manifest $m -ComponentId $component.id -Action $action -RuntimeRoot $runtime | Out-Null}
                catch{if($_.Exception.Message -cne 'INSTALLED_LIFECYCLE_BINDINGS_REQUIRED'){throw};$rejections++}
            }
            try{Invoke-McpCcComponentUiAction -Manifest $m -ComponentId $component.id -ActionId copy_mcp_url -RuntimeRoot $runtime|Out-Null}
            catch{if($_.Exception.Message -cne 'INSTALLED_LIFECYCLE_BINDINGS_REQUIRED'){throw};$rejections++}
        }
        [pscustomobject]@{rejections=$rejections;launches=$script:launches}
    } $v4 (Join-Path $fixture 'unused')
    Check ($blockedCalls.rejections -eq 72 -and $blockedCalls.launches -eq 0) 'Every Core mutation on all eight components rejects before launch'
    $plan=@(Get-McpCcReconcilePlan -Manifest $v4 -State ([pscustomobject]@{}))
    Check ($plan.Count -eq 8 -and @($plan|Where-Object {$_.decision -ne 'ManualAttention'}).Count -eq 0) 'Reconcile plan never offers Start or Repair for pending v4'
    Denied {Get-McpCcControllerAudit -Manifest $v4 -RuntimeRoot (Join-Path $fixture 'unused')} 'INSTALLED_LIFECYCLE_BINDINGS_REQUIRED'
    Denied {Test-McpCcManifest -Manifest $v4} 'INSTALLED_LIFECYCLE_BINDINGS_REQUIRED'
    foreach($action in @('Status','Doctor','Reconcile','Start','Restart','RestartMcp','RepairConnectivity','RestartCore','ShutdownRuntime','ShowDiagnosticTray','ComponentMenuAction','SelfTest')){
        $result=@(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $manager 'scripts\control-center.ps1') -ManifestPath $v4Path -RuntimeRoot (Join-Path $fixture 'unused') -Action $action -Component codex_bridge -UiAction copy_mcp_url)
        $code=$LASTEXITCODE;$diagnostic=($result -join "`n")|ConvertFrom-Json
        Check ($diagnostic.code -eq 'INSTALLED_LIFECYCLE_BINDINGS_REQUIRED' -and $diagnostic.componentLaunches -eq 0 -and $code -eq $(if($action -in @('Status','Doctor')){0}else{1})) ('CLI guard/diagnostic: '+$action)
    }
    $result=@(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $manager 'scripts\control-center.ps1') -ManifestPath $v4Path -RuntimeRoot (Join-Path $fixture 'unused') -Action Reconcile -PlanOnly)
    Check ($LASTEXITCODE -eq 0 -and (($result -join "`n")|ConvertFrom-Json).componentLaunches -eq 0) 'CLI plan remains static and read-only'
    $trayInfo=New-Object Diagnostics.ProcessStartInfo
    $trayInfo.FileName=Join-Path $PSHOME 'powershell.exe';$trayInfo.UseShellExecute=$false;$trayInfo.CreateNoWindow=$true
    $trayInfo.RedirectStandardOutput=$true;$trayInfo.RedirectStandardError=$true
    $trayInfo.Arguments="-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $manager 'scripts\tray.ps1')`" -ManifestPath `"$v4Path`" -RuntimeRoot `"$(Join-Path $fixture 'unused')`" -AutoReconcile"
    $tray=[Diagnostics.Process]::Start($trayInfo)
    try{$errorText=$tray.StandardError.ReadToEnd();$null=$tray.StandardOutput.ReadToEnd();$tray.WaitForExit();Check ($tray.ExitCode -ne 0 -and $errorText -match 'INSTALLED_LIFECYCLE_BINDINGS_REQUIRED') 'Tray rejects before mutex/PID/UI/AutoReconcile'}finally{$tray.Dispose()}
    Check (-not (Test-Path -LiteralPath (Join-Path $fixture 'unused'))) 'All diagnostics and blocked entries left runtime root absent'
    # v3 still reaches the existing fixed mapping; PlanOnly never launches fixture code.
    $v3Plan=Invoke-McpCcComponentAction -Manifest $v3 -ComponentId codex_bridge -Action reload_runtime -PlanOnly -RuntimeRoot (Join-Path $fixture 'unused')
    Check ($v3Plan.planned -and $v3Plan.action -eq 'reload_runtime') 'v3 controller mapping remains available'
    foreach($bad in @('..\codex_bridge','C:\arbitrary','codex_bridge:stream','project_reading')){
        $registry.components[4].root=$bad;Write-Json $v4Path $registry
        Denied {Read-McpCcManifest -Path $v4Path} 'INSTALLED_COMPONENT_NOT_ALLOWED'
    }
    $registry.components[4].root='codex_bridge'
    $registry.components[4].id='unregistered';Write-Json $v4Path $registry
    Denied {Read-McpCcManifest -Path $v4Path} 'INSTALLED_COMPONENT_NOT_ALLOWED'
    $registry.components[4].id='codex_bridge';Write-Json $v4Path $registry
    $releaseDocument.releaseId='wrong-version';Write-Json $releasePath $releaseDocument
    Denied {Read-McpCcManifest -Path $v4Path} 'INSTALLED_MANIFEST_INVALID'
    $releaseDocument.releaseId='release-a'
    foreach($bad in @('C:\fixture\..\other','C:\fixture:stream','\\server\share','C:\fixture\trailing.')){
        $releaseDocument.legacyWorkspaceRoot=$bad;Write-Json $releasePath $releaseDocument
        Denied {Read-McpCcManifest -Path $v4Path} 'INSTALLED_PATH_INVALID'
    }
    $releaseDocument.legacyWorkspaceRoot=$legacy;$releaseDocument.dependencies.node='C:\mutable\node.exe';Write-Json $releasePath $releaseDocument
    Denied {Read-McpCcManifest -Path $v4Path} 'INSTALLED_DEPENDENCY_HASH_INVALID'
    $releaseDocument.dependencies.node='a'*64;Write-Json $releasePath $releaseDocument
    $installed=Import-Module (Join-Path $manager 'src\McpControlCenter.InstalledRelease.psm1') -PassThru
    # SDDL objects in memory only. No Set-Acl, account, registry, private-policy or secret access.
    $aclResults=& $installed {
        $results=@()
        foreach($sddl in @('O:SYG:SYD:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;BU)',
            'O:BUG:SYD:(A;;FA;;;SY)', 'O:SYG:SYD:(A;;FW;;;BU)',
            'O:SYG:SYD:(A;;DC;;;BU)', 'O:SYG:SYD:(A;;WD;;;BU)', 'O:SYG:SYD:(A;;WO;;;BU)',
            'O:SYG:SYD:(A;OICIIO;FW;;;BU)')) {
            $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetSecurityDescriptorSddlForm($sddl)
            $accepted=$true;try{Assert-McpCcProtectedAcl $acl}catch{$accepted=$false};$results+=,$accepted
        };$results
    }
    Check ($aclResults[0] -eq $true) 'Protected owner with runtime RX passes ACL predicate'
    foreach($rejected in @($aclResults | Select-Object -Skip 1)){Check (-not $rejected) 'Mutable owner/write/delete/ACL/owner/inherit-only denied'}
    Denied {& $installed {param($p) Assert-McpCcProtectedCodePath $p} $manager} 'PROTECTED_(OWNER_REQUIRED|WRITE_REJECTED)'
    # A synthetic large tree exercises real enumeration with injected ACL reads; no ACL mutation.
    $tree=Join-Path $fixture 'large-tree';New-Item -ItemType Directory -Path $tree | Out-Null
    for($i=0;$i -lt 1000;$i++){[IO.File]::WriteAllText((Join-Path $tree "$i.js"),'fixture',$utf8)}
    $clock=[Diagnostics.Stopwatch]::StartNew()
    $scan=& $installed {
        param($p)
        $script:aclCalls=0
        $script:goodAcl=New-Object Security.AccessControl.DirectorySecurity
        $script:goodAcl.SetSecurityDescriptorSddlForm('O:SYG:SYD:(A;;FA;;;SY)(A;;FRFX;;;BU)')
        function script:Get-Acl {param($LiteralPath) $script:aclCalls++;$script:goodAcl}
        Assert-McpCcProtectedCodeTree $p
        $first=$script:aclCalls
        Assert-McpCcProtectedCodeTree $p
        [pscustomobject]@{first=$first;second=($script:aclCalls-$first)}
    } $tree
    $clock.Stop()
    Check ($scan.first -ge 1001 -and $scan.first -lt 1020 -and $scan.second -eq $scan.first) 'Linear ACL reads; no ancestor-per-file amplification or persistent trust cache'
    # Exercise the declared dependency closure using real fixture files/hashes. Only ACL
    # reads are synthetic; this is not a protected-installation acceptance signal.
    foreach($relative in @('src\RemoteSelfReload.Native.cs','scripts\tray.ps1')){
        $p=Join-Path $manager $relative;if(-not(Test-Path -LiteralPath $p)){[IO.File]::WriteAllText($p,'fixture',$utf8)}
    }
    foreach($relative in @('scripts\codex-bridge-runtime.psm1','scripts\OwnedProcess.Native.cs','scripts\self-reload-pipe-client.ps1',
        'dist\src\http-main.js','web\self-reload.html','package.json','package-lock.json','node_modules\@openai\codex\bin\codex.js')){
        $p=Join-Path $releaseRoot "codex_bridge\$relative";New-Item -ItemType Directory -Force -Path (Split-Path -Parent $p)|Out-Null
        [IO.File]::WriteAllText($p,'fixture',$utf8)
    }
    $release=Read-McpCcInstalledRelease -ManagerRoot $manager
    foreach($name in @('node','tunnelClient','keyStore')){
        $p=$release.dependencies[$name].path;New-Item -ItemType Directory -Force -Path (Split-Path -Parent $p)|Out-Null
        [IO.File]::WriteAllText($p,('fixed dependency '+$name),$utf8)
        $releaseDocument.dependencies.$name=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    Write-Json $releasePath $releaseDocument;$release=Read-McpCcInstalledRelease -ManagerRoot $manager
    Assert-McpCcInstalledClosure $release
    Check $true 'Declared fixed dependency hashes and code tree pass under synthetic protected ACLs'
    $keyPath=$release.dependencies['keyStore'].path
    [IO.File]::AppendAllText($keyPath,'tampered',$utf8)
    Denied {Assert-McpCcInstalledClosure $release} 'INSTALLED_DEPENDENCY_HASH_MISMATCH'
    [IO.File]::WriteAllText($keyPath,'fixed dependency keyStore',$utf8)
    Remove-Item -LiteralPath $keyPath
    Denied {Assert-McpCcInstalledClosure $release} 'Cannot find path|does not exist'
    [IO.File]::WriteAllText($keyPath,'fixed dependency keyStore',$utf8)
    Denied {Assert-McpCcInstalledActivation $v4} 'INSTALLED_LIFECYCLE_BINDINGS_REQUIRED'
    # A reparse anywhere in the ancestor chain is rejected before ACL or descent.
    $reparseDenied=& $installed {
        param($p)
        $script:reparseAncestor=Split-Path -Parent $p
        function script:Get-Item {param($LiteralPath,[switch]$Force)
            if($LiteralPath -eq $script:reparseAncestor){return [pscustomobject]@{Attributes=[IO.FileAttributes]::ReparsePoint}}
            Microsoft.PowerShell.Management\Get-Item -LiteralPath $LiteralPath -Force
        }
        try{Assert-McpCcProtectedCodePath $p;return $false}catch{return $_.Exception.Message -eq 'INSTALLED_REPARSE_REJECTED'}
        finally{Remove-Item Function:\Get-Item}
    } $tree
    Check $reparseDenied 'Reparse ancestor rejected (synthetic filesystem boundary)'
    # Fail a protected child's ancestor using the same production ancestor walker.
    $ancestorDenied=& $installed {
        param($p)
        $script:badAncestor=Split-Path -Parent $p
        function script:Get-Acl {param($LiteralPath)
            if($LiteralPath -eq $script:badAncestor){$a=New-Object Security.AccessControl.DirectorySecurity;$a.SetSecurityDescriptorSddlForm('O:SYG:SYD:(A;;FW;;;BU)');return $a}
            $script:goodAcl
        }
        try{Assert-McpCcProtectedCodePath $p;return $false}catch{return $_.Exception.Message -eq 'PROTECTED_WRITE_REJECTED'}
    } $tree
    Check $ancestorDenied 'Protected child cannot hide writable ancestor'
    $releaseDocument.schemaVersion=3;$releaseDocument.contract='mcpcc-installed-release-v3'
    Write-Json $releasePath $releaseDocument # Intentionally missing required v3 binding fields.
    $unusedState=Join-Path $fixture 'must-not-create-on-gate-error'
    $output=& (Join-Path $PSHOME 'powershell.exe') -NoProfile -File (Join-Path $manager 'scripts\control-center.ps1') -Action ComponentMenuAction -Component codex_bridge -UiAction copy_health_url -RuntimeRoot $unusedState
    $errorExit=$LASTEXITCODE;$failure=($output -join "`n")|ConvertFrom-Json
    Check ($errorExit -ne 0 -and -not $failure.ok -and -not(Test-Path -LiteralPath $unusedState)) 'Malformed v3 release cannot fall through to legacy error/state writers'
    [pscustomobject]@{ok=$true;assertions=$passed;synthetic=$true;g1='PARTIAL';largeTreeFiles=1000;aclReadsPerScan=$scan.first;
        twoScanMilliseconds=$clock.ElapsedMilliseconds;productionRuntimeTouched=$false}|ConvertTo-Json
} finally {
    $resolved=[IO.Path]::GetFullPath($fixture)
    if (-not $resolved.StartsWith($tempBase+'\',[StringComparison]::OrdinalIgnoreCase)) {throw 'UNSAFE_FIXTURE_CLEANUP'}
    if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
