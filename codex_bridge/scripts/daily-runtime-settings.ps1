# Shared by the existing Bridge controller and CC loader. Paths only; no credentials.
function Read-CbDailySettings([string]$ReleaseRoot) {
    $runtime='C:\GPT_MCPtool\codex_bridge\Runtime'
    $full=[IO.Path]::GetFullPath($ReleaseRoot).TrimEnd('\')
    if((Split-Path -Parent $full) -ine (Join-Path $runtime 'versions') -or
        (Split-Path -Leaf $full) -cnotmatch '^[a-z0-9][a-z0-9_-]{0,47}$') { throw 'DAILY_LAYOUT_REJECTED' }
    if(Test-Path -LiteralPath (Join-Path $full 'mcp_control_center\config\installed-release.json')) { throw 'DAILY_PROTECTED_MIGRATION_REQUIRED' }
    $path=Join-Path $runtime 'settings.json'
    if((Get-Item -LiteralPath $path -Force).Length -gt 16384){throw 'DAILY_SETTINGS_LIMIT'}
    $settings=Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
    $names=@('contract','operatorSid','dataDir','ownerRoot','bridgeRuntimeDir','projectsFile','codexHome','codexCommand','nodePath','tunnelClientPath','tunnelProfileDir','keyStorePath','secretPath')
    if((@($settings.PSObject.Properties.Name | Sort-Object) -join ',') -cne (@($names | Sort-Object) -join ',') -or
        $settings.contract -cne 'mcpcc-daily-user-v1' -or
        $settings.operatorSid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'DAILY_SETTINGS_INVALID' }
    if(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'DAILY_NON_ADMIN_REQUIRED' }
    foreach($name in @($names | Where-Object {$_ -notin @('contract','operatorSid')})) {
        $p=[string]$settings.$name
        if($p -imatch '^C:\\Program Files\\McpCcReleases(?:\\|$)'){throw 'DAILY_LEGACY_DEPENDENCY_REJECTED'}
        if($p -notmatch '^[A-Za-z]:\\' -or $p -match '["\r\n]|(^|\\)\.\.(\\|$)' -or [IO.Path]::GetFullPath($p).TrimEnd('\') -ine $p) { throw 'DAILY_SETTINGS_PATH_INVALID' }
        if($p -ieq $runtime -or $p.StartsWith($runtime+'\',[StringComparison]::OrdinalIgnoreCase) -or $runtime.StartsWith($p+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'DAILY_STATE_CODE_OVERLAP' }
        $cursor=$p
        while($cursor) {
            $item=Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
            if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'DAILY_REPARSE_REJECTED'}
            $cursor=Split-Path -Parent $cursor
        }
    }
    return $settings
}

function New-CbDailyContext([string]$CodeRoot,[switch]$RequireBearer) {
    $s=Read-CbDailySettings (Split-Path -Parent $CodeRoot)
    if($env:CODEX_HOME -and $env:CODEX_HOME -ine $s.codexHome){throw 'DAILY_CONFIG_CHANGED_MIGRATION_REQUIRED'}
    $env:CODEX_HOME=$s.codexHome
    $args=@{ProjectRoot=$CodeRoot;DataDir=$s.dataDir;ProjectsFile=$s.projectsFile;CodexCommand=$s.codexCommand;
        NodePath=$s.nodePath;TunnelClientPath=$s.tunnelClientPath;TunnelProfileDir=$s.tunnelProfileDir;
        KeyStorePath=$s.keyStorePath;SecretPath=$s.secretPath;Token=$null}
    $context=New-CodexBridgeRuntimeContext @args
    # PID/owner metadata and logs are persistent operational state, never code files.
    $context.runtimeDir=$s.bridgeRuntimeDir
    foreach($pair in @(@('serverPidFile','codex-bridge-http-server.pid'),@('serverOwnerFile','codex-bridge-http-server.owner.json'),
        @('tunnelPidFile','tunnel-client.pid'),@('tunnelOwnerFile','tunnel-client.owner.json'),@('tunnelLogFile','tunnel-client.log'),@('actionLogFile','runtime-control.jsonl'))) {
        $context.($pair[0])=Join-Path $s.bridgeRuntimeDir $pair[1]
    }
    $context | Add-Member -NotePropertyName requireAllJobs -NotePropertyValue $true
    if($RequireBearer){
        . (Join-Path $PSScriptRoot 'daily-bearer.ps1')
        Set-CbDailyContextBearer $context $s
    }
    return $context
}
