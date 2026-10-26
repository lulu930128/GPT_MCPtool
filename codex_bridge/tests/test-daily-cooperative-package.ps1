# Real packaged dependency/native-loader checks. No listener, secret or lifecycle mutation.
param([string]$ReleaseRoot)
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('daily-cooperative-'+[guid]::NewGuid().ToString('N'))
$count=0
function Check([bool]$Value,[string]$Name){if(-not $Value){throw ('FAILED: '+$Name)};$script:count++}
function Put([string]$Path,[string]$Text){[void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path));[IO.File]::WriteAllText($Path,$Text)}
function Refused([scriptblock]$Body,[string]$Code){$message='';try{& $Body|Out-Null}catch{$message=$_.Exception.Message};Check ($message.StartsWith($Code)) $Code}
try {
    $release=Join-Path $fixture 'codex_bridge/Runtime/versions/v1'
    $bridge=Join-Path $release 'codex_bridge'
    Put (Join-Path $release 'daily-mode.json') '{"contract":"mcpcc-daily-user-v1","trayOwner":"independent-cc"}'
    foreach($name in @('codex-bridge-runtime.psm1','cooperative-layout.ps1','cooperative-shutdown-host.ps1','process-identity.ps1','OwnedProcess.Native.cs')){
        Put (Join-Path $bridge ('scripts/'+$name)) ([IO.File]::ReadAllText((Join-Path $repo ('codex_bridge/scripts/'+$name))))
    }
    foreach($name in @('NormalOperator.Native.cs','RemoteSelfReload.Native.cs')){
        Put (Join-Path $bridge ('scripts/shared-native/'+$name)) ([IO.File]::ReadAllText((Join-Path $repo ('mcp_control_center/src/'+$name))))
    }
    foreach($name in @('cooperative-shutdown.js','process-identity.js')){Put (Join-Path $bridge ('dist/src/'+$name)) '// fixture transport entry'}
    $module=Import-Module (Join-Path $bridge 'scripts/codex-bridge-runtime.psm1') -Force -PassThru
    & $module {param($b) Assert-CbCooperativeSourceAvailable @{projectRoot=$b}} $bridge
    $count++
    Check (-not(Test-Path -LiteralPath (Join-Path $release 'mcp_control_center'))) 'no embedded CC'
    $missing=Join-Path $bridge 'scripts/shared-native/NormalOperator.Native.cs'
    $bytes=[IO.File]::ReadAllBytes($missing);[IO.File]::Delete($missing)
    Refused {& $module {param($b) Assert-CbCooperativeSourceAvailable @{projectRoot=$b}} $bridge} 'COOPERATIVE_SOURCE_INCOMPLETE'
    [IO.File]::WriteAllBytes($missing,$bytes)
    . (Join-Path $bridge 'scripts/cooperative-layout.ps1')
    $cc=Join-Path $fixture 'mcp_control_center/Runtime'
    $ccRoot=Join-Path $cc 'versions/cc1'
    $wrapper=Join-Path $ccRoot 'scripts/invoke-component-controller.ps1'
    Put $wrapper ([IO.File]::ReadAllText((Join-Path $repo 'mcp_control_center/scripts/invoke-component-controller.ps1')))
    Put (Join-Path $cc 'current.json') '{"contract":"mcpcc-current-v1","version":"cc1"}'
    Put (Join-Path $ccRoot 'cc-runtime.json') '{"contract":"mcpcc-runtime-v1","version":"cc1"}'
    $inventory=@{contract='mcpcc-code-inventory-v1';version='cc1';files=@(@{path='scripts/invoke-component-controller.ps1';sha256=(Get-FileHash -LiteralPath $wrapper).Hash})}
    Put (Join-Path $ccRoot 'code-inventory.json') ($inventory|ConvertTo-Json -Depth 5)
    Check ((Get-CbCooperativeControllerWrapper $bridge) -ieq $wrapper) 'selected independent wrapper'
    $tokens=$null;$errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $bridge 'scripts/cooperative-shutdown-host.ps1'),[ref]$tokens,[ref]$errors)
    Check ($errors.Count -eq 0) 'host syntax'
    $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Test-CbCooperativeControllerCommandLine'},$true)
    $body=$fn.Body.Extent.Text
    $verify=[scriptblock]::Create('param($CommandLine,$ScriptsRoot) $PSScriptRoot=$ScriptsRoot'+"`n"+$body.Substring(1,$body.Length-2))
    $scripts=Join-Path $bridge 'scripts'
    $controller=Join-Path $scripts 'runtime-control.ps1'
    $exe='"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"'
    foreach($action in @('RestartCore','ReloadRuntime','ShutdownRuntime')){
        $json=[pscustomobject]@{arguments=@('-Action',$action)}|ConvertTo-Json -Compress
        $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
        $line=$exe+' -NoProfile -ExecutionPolicy Bypass -File "'+$wrapper+'" -ControllerPath "'+$controller+'" -ArgumentsBase64 '+$encoded+' -ResultPipeHandle 1234 -MaxCapturedOutputBytes 65536'
        Check (& $verify $line $scripts) ('selected CC '+$action)
        Check (-not(& $verify ($line.Replace($wrapper,(Join-Path $release 'mcp_control_center/scripts/invoke-component-controller.ps1'))) $scripts)) 'old bundled wrapper rejected'
    }
    Check (-not(& $verify ($line+' -Command exit') $scripts)) 'extra command rejected'
    Put $wrapper '// modified wrapper'
    Check (-not(& $verify $line $scripts)) 'modified wrapper rejected'
    Refused {Get-CbCooperativeControllerWrapper $bridge} 'COOPERATIVE_CC_WRAPPER_CHANGED'
    Put (Join-Path $cc 'current.json') '{"contract":"mcpcc-current-v1","version":"../cc1"}'
    Refused {Get-CbCooperativeControllerWrapper $bridge} 'COOPERATIVE_CC_SELECTOR_INVALID'
    Put (Join-Path $cc 'current.json') '{"contract":"wrong","version":"cc1"}'
    Refused {Get-CbCooperativeControllerWrapper $bridge} 'COOPERATIVE_CC_SELECTOR_INVALID'
    if($ReleaseRoot){
        # Use the real immutable stage for native loading when supplied, before
        # any fixture assembly is loaded into this PowerShell process.
        $bridge=Join-Path ([IO.Path]::GetFullPath($ReleaseRoot)) 'codex_bridge'
        $module=Import-Module (Join-Path $bridge 'scripts/codex-bridge-runtime.psm1') -Force -PassThru
        & $module {param($b) Assert-CbCooperativeSourceAvailable @{projectRoot=$b}} $bridge
        $count++
    }
    & $module {Initialize-CbCooperativeNative}
    Check ($null -ne ('McpCcNormalNative' -as [type])) 'actual normal native compiled and loaded'
    Check ($null -ne ('McpCcReloadNative' -as [type])) 'actual reload native compiled and loaded'
    # Identity adapter invokes the same loader in its own process; no live service.
    $identity=& 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -File (Join-Path $bridge 'scripts/process-identity.ps1') -ProcessId $PID
    Check ($LASTEXITCODE -eq 0) 'packaged identity adapter exits successfully'
    $proof=($identity -join "`n")|ConvertFrom-Json
    Check ($proof.pid -eq $PID) 'packaged identity adapter inspects requested test process'
    [pscustomobject]@{ok=$true;passed=$count;scope=$(if($ReleaseRoot){'staged package'}else{'isolated package'});live=$false}|ConvertTo-Json
} finally {
    if(Test-Path -LiteralPath $fixture){
        $resolved=(Resolve-Path -LiteralPath $fixture).Path
        if((Split-Path -Parent $resolved) -ine [IO.Path]::GetTempPath().TrimEnd('\') -or (Split-Path -Leaf $resolved) -cnotmatch '^daily-cooperative-[0-9a-f]{32}$'){throw 'FIXTURE_CLEANUP_REJECTED'}
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
