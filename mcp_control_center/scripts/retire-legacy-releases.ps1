# Delete only the reviewed Program Files code releases after verified cutover.
# No process termination, ACL changes, state migration or automatic retries.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$AcceptanceReceipt,[switch]$Apply)
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$legacyRoot='C:\Program Files\McpCcReleases'
$workspace='C:\GPT_MCPtool'
$bridgeRuntime=Join-Path $workspace 'codex_bridge\Runtime'
$reviewed=@('normal-direct-20261022-r12','normal-direct-bearer-20261023','normal-mvp-20261016-r3',
    'normal-mvp-20261017-r4','normal-mvp-20261017-r5','normal-mvp-20261017-r6','normal-mvp-20261017-r7','normal-mvp-20261017-r8',
    'normal-mvp-20261020-r9','normal-mvp-20261020-r10','normal-mvp-20261020-r11','r12-stable-pathfix-20261023',
    'runtime-owner-20261022-r13','runtime-owner-20261022-r14','runtime-owner-20261022-r15','runtime-owner-20261023-r16','runtime-owner-20261023-r17')
$daily=Import-Module (Join-Path $workspace 'mcp_control_center\src\McpControlCenter.DailyCode.psm1') -Force -PassThru
Import-Module (Join-Path $workspace 'mcp_control_center\src\McpControlCenter.Deployment.psm1') -Force
$op=$null;$lock=$null;$deleted=@()
function Read-RetirementJson([string]$Path){return & $daily {param($p) Read-DailyJson $p} $Path}
function Write-RetirementNew([string]$Name,$Value){& $daily {param($p,$v) Write-DailyNew $p $v} (Join-Path $op $Name) $Value}
function Assert-RetirementTarget([string]$Path,[string]$Root,[string[]]$Names){
    $full=[IO.Path]::GetFullPath($Path).TrimEnd('\')
    $base=[IO.Path]::GetFullPath($Root).TrimEnd('\')
    if((Split-Path -Parent $full) -ine $base -or (Split-Path -Leaf $full) -cnotin $Names){throw 'RETIREMENT_TARGET_REJECTED'}
    & $daily {param($p) Assert-DailyPath $p} $full
    return $full
}
function Get-RetirementCodeInventory([string]$Path){
    $top=@(Get-ChildItem -LiteralPath $Path -Force)
    if(@($top|Where-Object {-not $_.PSIsContainer -or $_.Name -cnotin @('codex_bridge','mcp_control_center','dependencies')}).Count){throw 'RETIREMENT_UNREVIEWED_ROOT'}
    $stack=New-Object 'Collections.Generic.Stack[string]';$stack.Push($Path);$files=0;$bytes=[long]0
    while($stack.Count){foreach($item in Get-ChildItem -LiteralPath $stack.Pop() -Force){
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'RETIREMENT_REPARSE_REJECTED'}
        $relative=$item.FullName.Substring($Path.Length+1).Replace('\','/')
        if($relative -match '(^|/)(\.local|\.secrets)(/|$)|(^|/)\.env($|\.)|\.(sqlite[0-9]*(-wal|-shm)?|db|dpapi|pfx|pem|key)$' -or
            $relative -match '^(codex_bridge|mcp_control_center)/(Runtime|data)(/|$)'){throw 'RETIREMENT_PRIVATE_STATE_PRESENT'}
        if($item.PSIsContainer){$stack.Push($item.FullName)}else{$files++;$bytes+=$item.Length}
        if($files -gt 100000){throw 'RETIREMENT_FILE_LIMIT'}
    }}
    return [pscustomobject]@{path=$Path;files=$files;bytes=$bytes}
}
function Assert-NoLegacyProcesses {
    $matches=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
        ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($legacyRoot+'\',[StringComparison]::OrdinalIgnoreCase)) -or
        ($_.CommandLine -and $_.CommandLine.IndexOf($legacyRoot+'\',[StringComparison]::OrdinalIgnoreCase) -ge 0)
    })
    if($matches.Count){throw 'RETIREMENT_LEGACY_PROCESS_PRESENT'}
}
function Read-RetirementAcceptance([string]$Path,[string]$RuntimeRoot){
    $full=[IO.Path]::GetFullPath($Path)
    if((Split-Path -Parent $full) -ine (Join-Path $RuntimeRoot 'acceptance') -or
        (Split-Path -Leaf $full) -cnotmatch '^manual-start-[0-9a-f]{32}\.json$'){throw 'RETIREMENT_RECEIPT_PATH_REJECTED'}
    $accepted=Read-RetirementJson $full
    if($accepted.contract -cne 'mcpcc-manual-start-acceptance-v1' -or $accepted.phase -cne 'ACCEPTED' -or
        $accepted.authenticatedMcp -cne 'initialize PASS' -or $accepted.anonymousMcp -ne 401 -or
        $accepted.bridgeOwnerStatus -cne 'OwnedReady' -or $accepted.tunnelOwnerStatus -cne 'OwnedReady' -or
        $accepted.ccBridgeProbe -cne 'Ready'){throw 'RETIREMENT_ACCEPTANCE_REQUIRED'}
    return $accepted
}
function Assert-RetirementNoPending([string]$Root){
    & $daily {param($p) Assert-DailyPath $p} $Root
    if(-not(Test-Path -LiteralPath $Root)){return}
    foreach($attempt in Get-ChildItem -LiteralPath $Root -Directory -Force){
        $terminal=Join-Path $attempt.FullName 'terminal.json'
        if($attempt.Name -cnotmatch '^legacy-[0-9a-f]{32}$' -or -not(Test-Path -LiteralPath $terminal) -or
            (Read-RetirementJson $terminal).phase -cne 'RETIRED'){throw 'RETIREMENT_PENDING_UNKNOWN_DO_NOT_RETRY'}
    }
}
function Assert-RetirementLiveSelection {
    $path=[IO.Path]::GetFullPath($AcceptanceReceipt)
    $accepted=Read-RetirementAcceptance $path $bridgeRuntime
    $bridge=Read-RetirementJson (Join-Path $bridgeRuntime 'current.json')
    $ccRuntime=Join-Path $workspace 'mcp_control_center\Runtime'
    $cc=Read-RetirementJson (Join-Path $ccRuntime 'current.json')
    if($bridge.contract -cne 'mcpcc-daily-current-v1' -or $cc.contract -cne 'mcpcc-current-v1' -or
        $bridge.version -cne $accepted.bridgeVersion -or $cc.version -cne $accepted.controlCenterVersion){throw 'RETIREMENT_SELECTION_CHANGED'}
    $null=& $daily {param($r,$v) Test-DailyVersion $r $v} $bridgeRuntime $bridge.version
    $ccLayout=Test-McpCcDeploymentVersion $ccRuntime $cc.version
    $settings=Read-RetirementJson (Join-Path $bridgeRuntime 'settings.json')
    if($settings.operatorSid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value){throw 'RETIREMENT_OPERATOR_MISMATCH'}
    foreach($name in @('dataDir','ownerRoot','bridgeRuntimeDir','projectsFile','codexHome','codexCommand','nodePath','tunnelClientPath','tunnelProfileDir','keyStorePath','secretPath')){
        if(([string]$settings.$name).StartsWith($legacyRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'RETIREMENT_LEGACY_DEPENDENCY'}
    }
    $health=Invoke-RestMethod -Uri 'http://127.0.0.1:18828/health' -TimeoutSec 5
    if($health.ok -ne $true -or $health.pid -ne $accepted.bridgePid -or $health.buildId -cne $accepted.buildId){throw 'RETIREMENT_NEW_RUNTIME_CHANGED'}
    $process=Get-CimInstance Win32_Process -Filter "ProcessId=$($health.pid)" -ErrorAction Stop
    $entry=Join-Path $bridgeRuntime ('versions\'+$bridge.version+'\codex_bridge\dist\src\http-main.js')
    if($null -eq $process -or $process.ExecutablePath -ine $settings.nodePath -or $process.CommandLine.IndexOf($entry,[StringComparison]::OrdinalIgnoreCase) -lt 0){throw 'RETIREMENT_NEW_PROCESS_MISMATCH'}
    $trayId=[int][IO.File]::ReadAllText((Join-Path $settings.ownerRoot 'tray.pid')).Trim()
    $tray=Get-CimInstance Win32_Process -Filter "ProcessId=$trayId" -ErrorAction Stop
    $trayEntry=Join-Path $ccLayout.managerRoot 'scripts\tray.ps1'
    if($null -eq $tray -or $trayId -ne $accepted.trayPid -or
        $tray.ExecutablePath -ine 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -or
        $tray.CommandLine -notmatch ('(?i)-File\s+"'+[regex]::Escape($trayEntry)+'"(?:\s|$)')){throw 'RETIREMENT_CC_PROCESS_MISMATCH'}
    $shortcut=Join-Path ([Environment]::GetFolderPath('Startup')) 'MCP Control Center.lnk'
    $shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut($shortcut)
    if($link.TargetPath -ine 'C:\Windows\System32\wscript.exe' -or
        $link.Arguments -cne '"C:\GPT_MCPtool\mcp_control_center\scripts\start-runtime-tray.vbs" --boot' -or
        $link.WorkingDirectory -ine (Join-Path $workspace 'mcp_control_center')){throw 'RETIREMENT_STARTUP_MISMATCH'}
    Assert-NoLegacyProcesses
    return @{bridgeVersion=$bridge.version;ccVersion=$cc.version;bridgePid=$health.pid;trayPid=$trayId;acceptanceReceipt=$path}
}
try {
    if($PSVersionTable.PSEdition -cne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5){throw 'WINDOWS_POWERSHELL_REQUIRED'}
    if($Apply -and -not([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'RETIREMENT_ADMIN_REQUIRED'}
    $lock=& $daily {param($r) Open-DailyLock $r} $bridgeRuntime
    $base=Join-Path $bridgeRuntime 'retirements'
    Assert-RetirementNoPending $base
    $live=Assert-RetirementLiveSelection
    & $daily {param($p) Assert-DailyPath $p} $legacyRoot
    $plan=@()
    foreach($dir in Get-ChildItem -LiteralPath $legacyRoot -Directory -Force){
        if($dir.Name -ceq 'maintenance'){continue}
        $target=Assert-RetirementTarget $dir.FullName $legacyRoot $reviewed
        $plan+=Get-RetirementCodeInventory $target
    }
    if(-not $Apply){@{phase='VERIFIED_NOT_DELETED';live=$live;targets=$plan;maintenanceRetained=$true;dataChanged=$false}|ConvertTo-Json -Depth 6;exit 0}
    [void][IO.Directory]::CreateDirectory($base)
    $op=Join-Path $base ('legacy-'+[guid]::NewGuid().ToString('N'));[void][IO.Directory]::CreateDirectory($op)
    Write-RetirementNew 'intent.json' @{targets=$plan;live=$live;utc=[DateTime]::UtcNow.ToString('o');scriptSha256=(Get-FileHash -LiteralPath $PSCommandPath).Hash;dataChanged=$false;aclChanged=$false}
    foreach($row in $plan){
        Assert-NoLegacyProcesses
        $target=Assert-RetirementTarget $row.path $legacyRoot $reviewed
        $fresh=Get-RetirementCodeInventory $target
        if($fresh.files -ne $row.files -or $fresh.bytes -ne $row.bytes){throw 'RETIREMENT_TARGET_CHANGED'}
        # Native PowerShell end-to-end, exact absolute reviewed child only.
        Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
        if(Test-Path -LiteralPath $target){throw 'RETIREMENT_DELETE_INCOMPLETE'}
        $deleted+=$target
        Write-RetirementNew ('deleted-'+$deleted.Count+'.json') @{path=$target;utc=[DateTime]::UtcNow.ToString('o')}
    }
    $null=Assert-RetirementLiveSelection
    Write-RetirementNew 'terminal.json' @{phase='RETIRED';deleted=$deleted;maintenanceRetained=$true;dataChanged=$false;aclChanged=$false;runtimeRestarted=$false}
    @{phase='RETIRED';deletedCount=$deleted.Count;receipt=$op;dataChanged=$false;aclChanged=$false}|ConvertTo-Json
} catch {
    $code=([string]$_.Exception.Message -split ':')[0]
    if($code -cnotmatch '^[A-Z][A-Z0-9_]+$'){$code='RETIREMENT_FAILED'}
    if($op){Write-RetirementNew 'terminal.json' @{phase='UNKNOWN';code=$code;deleted=$deleted;automaticRetry=$false}}
    @{phase='BLOCKED';code=$code;receipt=$op;deletedCount=$deleted.Count;automaticRetry=$false}|ConvertTo-Json
    exit 1
} finally {if($lock){$lock.Dispose()}}
