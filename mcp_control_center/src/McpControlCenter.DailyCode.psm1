Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$script:Utf8=New-Object Text.UTF8Encoding($false)
$script:DailyTransaction=$null
$script:DailyOperationId=$null
$script:DailyOwnerTimeoutMs=180000
$script:DailyManagerRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$script:DailyWorkspaceRoot=Split-Path -Parent $script:DailyManagerRoot
if(Test-Path -LiteralPath (Join-Path $script:DailyManagerRoot 'cc-runtime.json')){
    Import-Module (Join-Path $PSScriptRoot 'McpControlCenter.Deployment.psm1')
    $script:DailyWorkspaceRoot=(Get-McpCcDeploymentLayout $script:DailyManagerRoot).workspaceRoot
}
# Incident-specific compatibility for the unchanged 2026-10-25 installed package.
# Exact deny paths were materialized by the Windows sandbox. Never apply to Stage
# or another manifest, and never exempt files, populated stores or reparse points.
$script:DailyLegacyEmptyVersion='pathfix-20261025-06'
$script:DailyLegacyEmptyManifest='66073f64efd71e39fe94bcad53a18cd0b03d98c4e580a4bc69cd4a51685ffedf'

function Assert-DailyPath([string]$Path) {
    $p=[IO.Path]::GetFullPath($Path)
    if($p -notmatch '^[A-Za-z]:\\' -or $p -match '["\r\n]|(^|\\)\.\.(\\|$)'){throw 'DAILY_PATH_REJECTED'}
    while($p) {
        if(Test-Path -LiteralPath $p) {
            if((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'DAILY_REPARSE_REJECTED'}
        }
        $p=Split-Path -Parent $p
    }
}
function Read-DailyJson([string]$Path) {
    Assert-DailyPath $Path
    if((Get-Item -LiteralPath $Path).Length -gt 16000000){throw 'DAILY_JSON_LIMIT'}
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}
function Write-DailyNew([string]$Path,$Value) {
    Assert-DailyPath $Path
    if(Test-Path -LiteralPath $Path){throw 'DAILY_RECEIPT_EXISTS'}
    $bytes=$script:Utf8.GetBytes(($Value|ConvertTo-Json -Depth 12))
    $temporary=Join-Path (Split-Path -Parent $Path) ('.pending-'+[guid]::NewGuid().ToString('N')+'.json')
    $stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
    # Publish only fully flushed JSON. A killed writer leaves its original bytes
    # under a .pending name; it cannot poison the terminal/resolution reader.
    [IO.File]::Move($temporary,$Path)
}
function Get-DailyDigest([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Assert-DailyCodePath([string]$Relative) {
    # Validate before including a relative path in diagnostics; never echo an absolute
    # path, traversal, alternate stream or control character supplied by a caller.
    if($Relative -match '(^|/)\.\.?(/|$)|[:\\\x00-\x1f\x7f"<>|?*]|[ .](/|$)|//|/$' -or
        $Relative -notmatch '^(codex_bridge|mcp_control_center)(/|$)'){throw 'DAILY_PACKAGE_PATH_REJECTED'}
    # data/runtime are also code namespaces (e.g. ajv/lib/runtime). Only the
    # explicit source/build/dependency trees may use them, not config or state roots.
    $codeTree=$Relative -match '^(codex_bridge/(src|dist|node_modules)|mcp_control_center/src)(/|$)'
    $codeFile=$Relative -match '\.(ts|tsx|js|jsx|mjs|cjs|ps1|psm1|cs|vbs)(\.map)?$'
    $rule=$null
    if($Relative -match '(^|/)(\.env[^/]*|\.local|\.tmp|\.git|\.secrets|\.tunnel-client|\.ssh|\.aws|\.azure|\.npmrc|\.pypirc|logs?|backups?|exports|credentials?|tokens?|secrets?)(/|$)' -or
        $Relative -match '(^|/)[^/]*\.local(\.[^/]*)?(/|$)') {$rule='private-state'}
    elseif(-not $codeTree -and $Relative -match '(^|/)(Runtime|data)(/|$)') {$rule='state-root'}
    elseif($Relative -match '\.(db|sqlite[0-9]*)(-(wal|shm|journal))?$|\.(dpapi|pem|key|pfx|p12|p8|log|pid|zip|7z|secret|token|credential)$|(^|/)(installed-release|auth)\.json$') {$rule='private-file'}
    elseif(-not $codeFile -and $Relative -match '(^|/)(token|credential|secret)[^/]*$') {$rule='credential-file'}
    if($rule) {
        # Credential filenames can themselves contain a value. Preserve their
        # parent path, but do not echo an arbitrary credential basename/suffix.
        $safeRelative=$Relative -replace '(^|/)(token|credential|secret)[^/]*(?=/|$)','$1<credential-name>'
        throw ('DAILY_PRIVATE_FILE_REJECTED: '+$safeRelative+' [rule='+$rule+']')
    }
}
function Get-DailyFiles([string]$Root,[switch]$AllowEmptyRuntimeInbox,[switch]$AllowLegacyEmptyDirectories) {
    Assert-DailyPath $Root
    $queue=New-Object 'Collections.Generic.Stack[string]';$queue.Push($Root)
    $rows=New-Object 'Collections.Generic.List[object]'
    while($queue.Count) {
        foreach($f in Get-ChildItem -LiteralPath $queue.Pop() -Force) {
            if($f.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'DAILY_REPARSE_REJECTED'}
            $relative=$f.FullName.Substring($Root.Length+1).Replace('\','/')
            if($relative -in @('daily-release.json','daily-mode.json')){continue}
            if($AllowLegacyEmptyDirectories -and $f.PSIsContainer){
                if($relative -cin @('codex_bridge/.local','codex_bridge/.env','codex_bridge/.secrets','codex_bridge/.tunnel-client') -and
                    @(Get-ChildItem -LiteralPath $f.FullName -Force).Count -eq 0){continue}
                if($relative -ceq 'project_reading'){
                    $children=@(Get-ChildItem -LiteralPath $f.FullName -Force)
                    if($children.Count -eq 1 -and $children[0].Name -ceq '.secrets' -and $children[0].PSIsContainer -and
                        -not($children[0].Attributes -band [IO.FileAttributes]::ReparsePoint) -and
                        @(Get-ChildItem -LiteralPath $children[0].FullName -Force).Count -eq 0){continue}
                }
            }
            # JobStore creates this empty directory during startup. It adds no
            # code bytes to the inventory. Never exempt contents or Stage inputs.
            if($AllowEmptyRuntimeInbox -and $f.PSIsContainer -and $relative -ceq 'codex_bridge/.tmp'){
                $children=@(Get-ChildItem -LiteralPath $f.FullName -Force)
                if($children.Count -eq 1 -and $children[0].Name -ceq 'codex-inbox' -and $children[0].PSIsContainer -and
                    -not($children[0].Attributes -band [IO.FileAttributes]::ReparsePoint) -and
                    @(Get-ChildItem -LiteralPath $children[0].FullName -Force).Count -eq 0){continue}
            }
            Assert-DailyCodePath $relative
            if($f.PSIsContainer){$queue.Push($f.FullName)}else{
                if($rows.Count -gt 100000){throw 'DAILY_FILE_LIMIT'}
                $rows.Add([pscustomobject]@{path=$relative;sha256=(Get-DailyDigest $f.FullName)})
            }
        }
    }
    return @($rows | Sort-Object path)
}
function Test-DailyVersion([string]$Root,[string]$Version) {
    if($Version -cnotmatch '^[a-z0-9][a-z0-9_-]{0,47}$'){throw 'DAILY_VERSION_INVALID'}
    $path=Join-Path $Root ('versions\'+$Version)
    $manifest=Read-DailyJson (Join-Path $path 'daily-release.json')
    if($manifest.contract -cne 'mcpcc-daily-code-v1' -or $manifest.version -cne $Version){throw 'DAILY_MANIFEST_INVALID'}
    $legacyEmpty=$Version -ceq $script:DailyLegacyEmptyVersion -and
        (Get-DailyDigest (Join-Path $path 'daily-release.json')) -ceq $script:DailyLegacyEmptyManifest
    $actual=@(Get-DailyFiles $path -AllowEmptyRuntimeInbox -AllowLegacyEmptyDirectories:$legacyEmpty)
    if(($actual|ConvertTo-Json -Compress) -cne (@($manifest.files)|ConvertTo-Json -Compress)){throw 'DAILY_INTEGRITY_FAILED'}
    $mode=Read-DailyJson (Join-Path $path 'daily-mode.json')
    if($mode.contract -cne 'mcpcc-daily-user-v1' -or -not $mode.PSObject.Properties['trayOwner'] -or $mode.trayOwner -cne 'independent-cc' -or
        @($actual | Where-Object {$_.path -notlike 'codex_bridge/*'}).Count){throw 'DAILY_INDEPENDENT_BRIDGE_REQUIRED'}
    foreach($required in @('codex_bridge/scripts/cooperative-layout.ps1','codex_bridge/scripts/shared-native/NormalOperator.Native.cs','codex_bridge/scripts/shared-native/RemoteSelfReload.Native.cs')){
        if($required -cnotin $actual.path){throw 'DAILY_COOPERATIVE_PACKAGE_INCOMPLETE'}
    }
    return $manifest
}
function New-McpDailyCandidate {
    param([string]$Root,[string]$Source,[string]$Version,[switch]$ReuseEquivalent)
    if(-not $Source -or $Version -cnotmatch '^[a-z0-9][a-z0-9_-]{0,47}$'){throw 'DAILY_SOURCE_VERSION_REQUIRED'}
    $Root=[IO.Path]::GetFullPath($Root).TrimEnd('\');$Source=[IO.Path]::GetFullPath($Source).TrimEnd('\')
    Assert-DailyPath $Root;Assert-DailyPath $Source
    if(Test-Path -LiteralPath (Join-Path $Source 'mcp_control_center\config\installed-release.json')){throw 'DAILY_PROTECTED_MIGRATION_REQUIRED'}
    $target=Join-Path $Root ('versions\'+$Version)
    $exists=Test-Path -LiteralPath $target
    if($exists -and -not $ReuseEquivalent){throw 'DAILY_VERSION_EXISTS'}
    # Explicit code trees only. Never recursively copy the checkout, Runtime or private state.
    # Preflight every tree using names/metadata before copying or hashing any file.
    $items=New-Object 'Collections.Generic.List[object]'
    # The source-only update sidecar belongs to CC admission, not the Bridge
    # runtime contract. Still scan its directory for forbidden metadata before
    # excluding that one declaration from the package.
    foreach($relative in @('codex_bridge/src','codex_bridge/dist','codex_bridge/web','codex_bridge/scripts','codex_bridge/control-center','codex_bridge/node_modules',
        'codex_bridge/package.json','codex_bridge/package-lock.json','codex_bridge/daily-code-contract.json')) {
        $from=Join-Path $Source $relative
        Assert-DailyPath $from
        $item=Get-Item -LiteralPath $from -Force
        Assert-DailyCodePath $relative
        if($item.PSIsContainer) {
            $stack=New-Object 'Collections.Generic.Stack[string]';$stack.Push($from)
            while($stack.Count) {
                foreach($child in Get-ChildItem -LiteralPath $stack.Pop() -Force) {
                    if($child.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'DAILY_REPARSE_REJECTED'}
                    $childRelative=$child.FullName.Substring($Source.Length+1).Replace('\','/')
                    Assert-DailyCodePath $childRelative
                    if(-not $child.PSIsContainer -and $childRelative -ceq 'codex_bridge/control-center/update.json'){continue}
                    if($child.PSIsContainer){$stack.Push($child.FullName)}else{$items.Add($child)}
                }
            }
        } else {$items.Add($item)}
    }
    foreach($required in @('codex_bridge/scripts/daily-code-owner.ps1','codex_bridge/scripts/daily-runtime-settings.ps1','codex_bridge/scripts/daily-bearer.ps1','codex_bridge/scripts/cooperative-layout.ps1','codex_bridge/dist/src/http-main.js')) {
        if(-not(Test-Path -LiteralPath (Join-Path $Source $required) -PathType Leaf)){throw ('DAILY_CANDIDATE_INCOMPLETE: '+$required)}
    }
    # Shared transport primitives retain one canonical source owner. Copy only
    # these two code dependencies, never the CC runtime, launcher or registry.
    $sharedNative=@('NormalOperator.Native.cs','RemoteSelfReload.Native.cs')
    if(Test-Path -LiteralPath (Join-Path $Source 'codex_bridge/scripts/shared-native')){throw 'DAILY_SHARED_NATIVE_SOURCE_COLLISION'}
    foreach($name in $sharedNative){
        $from=Join-Path $Source ('mcp_control_center/src/'+$name)
        Assert-DailyPath $from
        if(-not(Test-Path -LiteralPath $from -PathType Leaf)){throw ('DAILY_CANDIDATE_INCOMPLETE: mcp_control_center/src/'+$name)}
    }
    if($exists){
        $manifest=Test-DailyVersion $Root $Version
        $sourceFiles=@(foreach($f in $items){[pscustomobject]@{path=$f.FullName.Substring($Source.Length+1).Replace('\','/');sha256=(Get-DailyDigest $f.FullName)}})
        $sourceFiles+=@(foreach($name in $sharedNative){[pscustomobject]@{path=('codex_bridge/scripts/shared-native/'+$name);sha256=(Get-DailyDigest (Join-Path $Source ('mcp_control_center/src/'+$name)))}})
        if((@($sourceFiles|Sort-Object path)|ConvertTo-Json -Compress) -cne (@($manifest.files)|ConvertTo-Json -Compress)){throw 'DAILY_VERSION_CONTENT_CHANGED_USE_NEW_ID'}
        return @{phase='STAGED';version=$Version;root=$target;reused=$true;live='NOT_OPERATED'}
    }
    [void][IO.Directory]::CreateDirectory((Join-Path $Root 'staging'))
    [void][IO.Directory]::CreateDirectory((Join-Path $Root 'versions'))
    $stage=Join-Path $Root ('staging\'+$Version+'-'+[guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($stage)
    foreach($f in $items) {
        $rel=$f.FullName.Substring($Source.Length+1).Replace('\','/');Assert-DailyCodePath $rel
        Assert-DailyPath $f.FullName
        $dest=Join-Path $stage $rel;[void][IO.Directory]::CreateDirectory((Split-Path -Parent $dest))
        Copy-Item -LiteralPath $f.FullName -Destination $dest
        if((Get-DailyDigest $dest) -cne (Get-DailyDigest $f.FullName)){throw 'DAILY_COPY_CHANGED'}
    }
    foreach($name in $sharedNative){
        $from=Join-Path $Source ('mcp_control_center/src/'+$name)
        $dest=Join-Path $stage ('codex_bridge/scripts/shared-native/'+$name)
        Assert-DailyPath $from
        [void][IO.Directory]::CreateDirectory((Split-Path -Parent $dest))
        Copy-Item -LiteralPath $from -Destination $dest
        if((Get-DailyDigest $dest) -cne (Get-DailyDigest $from)){throw 'DAILY_COPY_CHANGED'}
    }
    Write-DailyNew (Join-Path $stage 'daily-mode.json') @{contract='mcpcc-daily-user-v1';trayOwner='independent-cc'}
    Write-DailyNew (Join-Path $stage 'daily-release.json') @{contract='mcpcc-daily-code-v1';version=$Version;files=@(Get-DailyFiles $stage)}
    # A failed/interrupted staging directory is retained; never overwrite a version.
    [IO.Directory]::Move($stage,$target)
    $null=Test-DailyVersion $Root $Version
    return @{phase='STAGED';version=$Version;root=$target;live='NOT_OPERATED'}
}
function Assert-DailyCompatible($Before,$After) {
    $old=@{};$next=@{}
    foreach($f in $Before.files){$old[$f.path]=$f.sha256}
    foreach($f in $After.files){$next[$f.path]=$f.sha256}
    $changed=@(@($old.Keys)+@($next.Keys) | Sort-Object -Unique | Where-Object {$old[$_] -cne $next[$_]})
    if(-not $changed.Count){throw 'DAILY_NO_CODE_CHANGE'}
    foreach($p in $changed) {
        # Filenames are not semantic contracts: installed-runtime and nested approval
        # source are ordinary code. Keep explicit compatibility/config/dependency
        # documents byte-identical; the author reviews semantics with -CodeOnly.
        if($p -match '(?i)(^|/)(migrations?|schema-migrations)(/|$)|\.sql$' -or
            $p -notmatch '^(codex_bridge/(src|dist/src|web|scripts)/.+\.(ts|js|mjs|map|html|css|svg|ps1|psm1|cs|vbs)|codex_bridge/dist/tests/.+\.(js|js\.map)|mcp_control_center/(src|scripts)/.+\.(ps1|psm1|cs|vbs))$') {
            throw ('DAILY_MIGRATION_REQUIRED: '+$p)
        }
    }
    return $changed
}
function Read-DailySettingsForVersion([string]$Root,[string]$Version) {
    . (Join-Path $Root ('versions\'+$Version+'\codex_bridge\scripts\daily-runtime-settings.ps1'))
    return Read-CbDailySettings (Join-Path $Root ('versions\'+$Version))
}
function Invoke-DailyOwner([string]$Root,[string]$Version,[string]$Action) {
    $release=Join-Path $Root ('versions\'+$Version)
    # Every adapter comes from source. It still loads the exact target owner and
    # invokes its original runtime-control for Stop; old snapshots stay untouched.
    $entry=Join-Path $script:DailyWorkspaceRoot 'codex_bridge\scripts\daily-code-owner.ps1'
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
    $info.Arguments='-NoProfile -NonInteractive -File "'+$entry+'" -ReleaseRoot "'+$release+'" -Action '+$Action
    if($Action -eq 'RecoverStopped'){$info.Arguments+=' -OperationId '+$script:DailyOperationId}
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    if($null -ne $script:DailyTransaction){
        $info.EnvironmentVariables['CB_DAILY_PARENT_PID']=[string]$PID
        $info.EnvironmentVariables['CB_DAILY_PARENT_TICKS']=[string](Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks
        $info.EnvironmentVariables['CB_DAILY_LOCK_HANDLE']=[string]$script:DailyTransaction.file.SafeFileHandle.DangerousGetHandle().ToInt64()
    }
    $p=$null;$finite=$Action -ne 'Start'
    try {
        if($finite){Initialize-DailyChildNative;$p=[CbDailyChild]::Start($info)}
        else {$p=New-Object Diagnostics.Process;$p.StartInfo=$info;if(-not $p.Start()){throw 'DAILY_OWNER_NOT_STARTED'};$null=$p.Handle}
        if($script:DailyOperationId){
            Write-DailyEvent $Root $script:DailyOperationId 'child' @{action=$Action;version=$Version;pid=$p.Id;startedUtc=$p.StartTime.ToUniversalTime().ToString('o')}
        }
        $capture=Read-DailyOwnerOutput $p $script:DailyOwnerTimeoutMs
        $output=$capture.stdout;$err=$capture.stderr
        if($output.Length -gt 16384 -or $err.Length -gt 16384){throw 'DAILY_OWNER_OUTPUT_UNKNOWN'}
        $result=$null
        try{$result=$output|ConvertFrom-Json}catch{}
        if($p.ExitCode -ne 0){
            if($result -and $result.PSObject.Properties['code'] -and [string]$result.code -cmatch '^[A-Z][A-Z0-9_]+$'){throw ([string]$result.code)}
            throw 'DAILY_OWNER_CHILD_FAILED'
        }
        if($null -eq $result -or $err.Length){throw 'DAILY_OWNER_OUTPUT_UNKNOWN'}
        if($result.ok -ne $true){throw ([string]$result.code)}
        if($result.PSObject.Properties['evidence']){return $result.evidence}
    } finally {
        if($p){
            # Finite scope closes only this updater-created helper subtree. Start
            # uses a lease watchdog; terminate only its retained adapter on timeout,
            # leaving any started service for same-operation observation/recovery.
            if(-not $finite -and -not $p.HasExited){$p.Kill();[void]$p.WaitForExit(5000)}
            $p.Dispose()
        }
    }
}
function Initialize-DailyChildNative {
    if(-not('CbDailyChild' -as [type])){Add-Type -Path (Join-Path $script:DailyWorkspaceRoot 'codex_bridge\scripts\DailyLifecycle.Native.cs')}
}
function Read-DailyOwnerOutput($Process,[int]$TimeoutMilliseconds) {
    $clock=[Diagnostics.Stopwatch]::StartNew()
    $outBuffer=New-Object char[] 1024;$errBuffer=New-Object char[] 256
    $outTask=$Process.StandardOutput.ReadAsync($outBuffer,0,$outBuffer.Length)
    $errTask=$Process.StandardError.ReadAsync($errBuffer,0,$errBuffer.Length)
    $stdout='';$stderr='';$outDone=$false;$errDone=$false
    while(-not($outDone -and $errDone -and $Process.HasExited)){
        if($clock.ElapsedMilliseconds -ge $TimeoutMilliseconds){throw 'DAILY_OWNER_TIMEOUT_UNKNOWN'}
        if(-not $outDone -and $outTask.IsCompleted){
            $n=$outTask.GetAwaiter().GetResult()
            if($n -eq 0){$outDone=$true}else{
                $stdout+=(-join $outBuffer[0..($n-1)])
                if($stdout.Length -gt 16384){throw 'DAILY_OWNER_OUTPUT_LIMIT'}
                $outTask=$Process.StandardOutput.ReadAsync($outBuffer,0,$outBuffer.Length)
            }
        }
        if(-not $errDone -and $errTask.IsCompleted){
            $n=$errTask.GetAwaiter().GetResult()
            if($n -eq 0){$errDone=$true}else{
                $stderr+=(-join $errBuffer[0..($n-1)])
                if($stderr.Length -gt 256){throw 'DAILY_OWNER_OUTPUT_LIMIT'}
                $errTask=$Process.StandardError.ReadAsync($errBuffer,0,$errBuffer.Length)
            }
        }
        Start-Sleep -Milliseconds 10
    }
    return @{stdout=$stdout;stderr=$stderr}
}
function Set-DailySelector([string]$Root,[string]$Version) {
    $path=Join-Path $Root 'current.json';$temp=Join-Path $Root ('selector-'+[guid]::NewGuid().ToString('N')+'.json')
    Write-DailyNew $temp @{contract='mcpcc-daily-current-v1';version=$Version}
    if(Test-Path -LiteralPath $path){[IO.File]::Replace($temp,$path,[NullString]::Value)}else{[IO.File]::Move($temp,$path)}
}
function Open-DailyLock([string]$Root) {
    Assert-DailyPath $Root
    return [IO.File]::Open((Join-Path $Root 'update.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
}
function Assert-DailyNoPending([string]$Root) {
    $ops=Join-Path $Root 'operations'
    if(Test-Path -LiteralPath $ops) {
        foreach($op in Get-ChildItem -LiteralPath $ops -Directory) {
            if(-not(Test-Path -LiteralPath (Join-Path $op.FullName 'terminal.json'))){throw 'DAILY_INTERRUPTED_UNKNOWN_DO_NOT_RETRY'}
            $t=Read-DailyJson (Join-Path $op.FullName 'terminal.json')
            if($t.phase -notin @('ACCEPTED','ROLLED_BACK','REJECTED')){
                if(-not(Test-Path -LiteralPath (Join-Path $op.FullName 'recovered-after-reboot.json'))){throw 'DAILY_INTERRUPTED_UNKNOWN_DO_NOT_RETRY'}
                Assert-DailyCutoverRebootRecovery $op.FullName
            }
        }
    }
}
function Get-DailyBootUtc {
    return (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime()
}
function Get-DailyCutoverRecoveryFacts([string]$Operation) {
    if((Split-Path -Leaf $Operation) -cnotmatch '^cutover-[0-9a-f]{32}$'){throw 'DAILY_RECOVERY_SCOPE_REJECTED'}
    $intent=Read-DailyJson (Join-Path $Operation 'intent.json')
    $failure=Read-DailyJson (Join-Path $Operation 'failure.json')
    $terminal=Read-DailyJson (Join-Path $Operation 'terminal.json')
    $stop=Read-DailyJson (Join-Path $Operation 'stop-intent.json')
    if($intent.inspect -ne $false -or $failure.phase -cne 'STOPPING_LEGACY' -or
        $failure.oldStopped -ne $false -or $failure.selected -ne $false -or $failure.startupChanged -ne $false -or
        $terminal.phase -cne 'UNKNOWN' -or $terminal.automaticRetry -ne $false -or $terminal.code -cne $failure.code -or
        $failure.code -cnotin @('CUTOVER_CONTROLLER_FAILED','DAILY_STATE_LOCK_PRESENT') -or
        $stop.phase -cne 'STOPPING_LEGACY' -or @($stop.roles).Count -ne 2){throw 'DAILY_RECOVERY_SCOPE_REJECTED'}
    $diagnostics=@()
    if($failure.code -ceq 'DAILY_STATE_LOCK_PRESENT'){
        $diagnostics=@(Get-ChildItem -LiteralPath $Operation -Filter 'controller-*.json' -File)
        $results=@($diagnostics | ForEach-Object {Read-DailyJson $_.FullName})
        $shutdown=@($results | Where-Object {$_.action -ceq 'ShutdownRuntime'})
        $stopped=@($results | Where-Object {$_.action -ceq 'Stopped'})
        if($shutdown.Count -ne 1 -or $shutdown[0].ok -ne $true -or $shutdown[0].exitCode -ne 0 -or
            $shutdown[0].stderrCharacters -ne 0 -or $shutdown[0].code -or
            $stopped.Count -ne 1 -or $stopped[0].ok -ne $false -or $stopped[0].exitCode -ne 1 -or
            $stopped[0].stderrCharacters -ne 0 -or $stopped[0].code -cne 'DAILY_STATE_LOCK_PRESENT'){
            throw 'DAILY_RECOVERY_STOP_EVIDENCE_REQUIRED'
        }
    }
    $boot=Get-DailyBootUtc
    # A healthy listener in the same boot is insufficient. Require an OS reboot
    # after the failed operation; all retained process handles belong to a retired epoch.
    if($boot -le [DateTime]::Parse($intent.utc).ToUniversalTime() -or
        $boot -le (Get-Item -LiteralPath (Join-Path $Operation 'terminal.json')).CreationTimeUtc){throw 'DAILY_RECOVERY_REBOOT_REQUIRED'}
    foreach($role in @('server','tunnel')){
        $rows=@($stop.roles | Where-Object {$_.role -ceq $role})
        if($rows.Count -ne 1 -or $rows[0].pid -isnot [int] -or $rows[0].pid -le 0 -or
            [DateTime]::Parse($rows[0].startTimeUtc).ToUniversalTime() -ge $boot){throw 'DAILY_RECOVERY_SCOPE_REJECTED'}
        $current=Get-CimInstance Win32_Process -Filter ('ProcessId='+$rows[0].pid) -ErrorAction Stop
        if($current){
            if($null -eq $current.CreationDate){throw 'DAILY_RECOVERY_PROCESS_TIME_UNKNOWN'}
            if($current.CreationDate.ToUniversalTime().Ticks -eq [DateTime]::Parse($rows[0].startTimeUtc).ToUniversalTime().Ticks){throw 'DAILY_RECOVERY_ORIGINAL_PROCESS_PRESENT'}
        }
    }
    $hashes=[ordered]@{}
    foreach($name in @('intent.json','observation.json','stop-intent.json','failure.json','terminal.json','startup.before.lnk')){
        $path=Join-Path $Operation $name;Assert-DailyPath $path
        $hashes[$name]=Get-DailyDigest $path
    }
    foreach($file in $diagnostics){$hashes[$file.Name]=Get-DailyDigest $file.FullName}
    return @{bootUtc=$boot.ToString('o');originalHashes=$hashes;operatorSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value}
}
function Assert-DailyCutoverRebootRecovery([string]$Operation) {
    $recovery=Read-DailyJson (Join-Path $Operation 'recovered-after-reboot.json')
    $facts=Get-DailyCutoverRecoveryFacts $Operation
    if($recovery.contract -cne 'mcpcc-cutover-reboot-recovery-v1' -or
        $recovery.operatorSid -cne $facts.operatorSid -or $recovery.operation -cne (Split-Path -Leaf $Operation) -or
        $recovery.originalTerminal -cne 'UNKNOWN' -or $recovery.newOperationRequired -ne $true -or $recovery.automaticRetry -ne $false -or
        [DateTime]::Parse($recovery.bootUtc).ToUniversalTime() -gt [DateTime]::Parse($facts.bootUtc).ToUniversalTime() -or
        [DateTime]::Parse($recovery.bootUtc).ToUniversalTime() -le (Get-Item -LiteralPath (Join-Path $Operation 'terminal.json')).CreationTimeUtc -or
        [DateTime]::Parse($recovery.bootUtc).ToUniversalTime() -le [DateTime]::Parse((Read-DailyJson (Join-Path $Operation 'intent.json')).utc).ToUniversalTime()){
        throw 'DAILY_RECOVERY_RECEIPT_INVALID'
    }
    if((@($recovery.originalHashes.PSObject.Properties.Name | Sort-Object) -join ',') -cne (@($facts.originalHashes.Keys | Sort-Object) -join ',')){throw 'DAILY_RECOVERY_RECEIPT_INVALID'}
    foreach($name in $facts.originalHashes.Keys){if($recovery.originalHashes.$name -cne $facts.originalHashes[$name]){throw 'DAILY_RECOVERY_ORIGINAL_CHANGED'}}
}
function Resolve-DailyCutoverAfterReboot([string]$Root,[string]$OperationName) {
    if($OperationName -cnotmatch '^cutover-[0-9a-f]{32}$'){throw 'DAILY_RECOVERY_SCOPE_REJECTED'}
    if(Test-Path -LiteralPath (Join-Path $Root 'current.json')){throw 'DAILY_RECOVERY_ALREADY_SELECTED'}
    $operation=Join-Path $Root ('operations\'+$OperationName)
    $path=Join-Path $operation 'recovered-after-reboot.json'
    if(Test-Path -LiteralPath $path){Assert-DailyCutoverRebootRecovery $operation;return}
    $facts=Get-DailyCutoverRecoveryFacts $operation
    Write-DailyNew $path @{contract='mcpcc-cutover-reboot-recovery-v1';operation=$OperationName;bootUtc=$facts.bootUtc;
        originalHashes=$facts.originalHashes;operatorSid=$facts.operatorSid;resolvedUtc=[DateTime]::UtcNow.ToString('o');
        originalTerminal='UNKNOWN';newOperationRequired=$true;automaticRetry=$false}
    Assert-DailyCutoverRebootRecovery $operation
}
function Assert-DailyRecoveryStopped([string]$Root,[string]$Version) {
    $tray=$null
    try {$tray=[Threading.Mutex]::OpenExisting('Local\McpControlCenterTray');throw 'DAILY_LEGACY_TRAY_PRESENT'}
    catch [Threading.WaitHandleCannotBeOpenedException] {} finally {if($tray){$tray.Dispose()}}
    foreach($folder in @([Environment]::GetFolderPath('Startup'),[Environment]::GetFolderPath('CommonStartup'))){
        if(Test-Path -LiteralPath (Join-Path $folder 'MCP Control Center.lnk')){throw 'DAILY_RECOVERY_STARTUP_PRESENT'}
    }
    $legacy=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
        $_.ExecutablePath -like 'C:\Program Files\McpCcReleases\*' -or
        ($_.Name -in @('powershell.exe','wscript.exe') -and $_.CommandLine -match '(?i)C:\\Program Files\\McpCcReleases\\')
    })
    if($legacy.Count){throw 'DAILY_RECOVERY_LEGACY_PROCESS_PRESENT'}
    try {Invoke-DailyOwner $Root $Version Stopped}
    catch {if($_.Exception.Message -cne 'DAILY_STATE_LOCK_PRESENT'){throw}}
}
function Move-DailyStaleApprovalLock([string]$Path,[string]$Backup,[DateTime]$Boot) {
    Assert-DailyPath $Path;Assert-DailyPath $Backup
    if((Split-Path -Parent $Path) -ine (Split-Path -Parent $Backup) -or
        (Split-Path -Leaf $Path) -cne 'approval.lock' -or
        (Split-Path -Leaf $Backup) -cnotmatch '^approval\.lock\.retired-[0-9a-f]{32}$' -or
        (Test-Path -LiteralPath $Backup)){throw 'DAILY_LOCK_RECOVERY_PATH_REJECTED'}
    $item=Get-Item -LiteralPath $Path -ErrorAction Stop
    if($item.Length -gt 4096 -or $item.CreationTimeUtc -ge $Boot -or $item.LastWriteTimeUtc -ge $Boot){throw 'DAILY_LOCK_RECOVERY_REBOOT_REQUIRED'}
    # This is only operational lock metadata. Never open the approval journal.
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
    try {
        $reader=New-Object IO.StreamReader($stream,[Text.Encoding]::UTF8)
        $text=$reader.ReadToEnd();$record=$text|ConvertFrom-Json
        if($record.contract -cne 'approval-lock-owner-v1' -or $record.identityStatus -cne 'OS_OBSERVED' -or
            $record.identity.pid -isnot [int] -or $record.identity.pid -le 0 -or
            $record.identity.sid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or
            $record.identity.image -ine 'C:\Program Files\McpCcReleases\normal-direct-bearer-20261023\dependencies\node\node.exe'){
            throw 'DAILY_LOCK_RECOVERY_OWNER_UNKNOWN'
        }
        $ticks=0L
        if(-not [long]::TryParse([string]$record.identity.startedUtcTicks,[ref]$ticks) -or $ticks -le 0 -or $ticks -ge $Boot.Ticks){throw 'DAILY_LOCK_RECOVERY_REBOOT_REQUIRED'}
        # Get-Process.StartTime can be null for an unrelated service that reused
        # the PID. CIM creation time verifies its epoch without opening its image.
        $current=Get-CimInstance Win32_Process -Filter ('ProcessId='+$record.identity.pid) -ErrorAction Stop
        if($current){
            if($null -eq $current.CreationDate){throw 'DAILY_LOCK_RECOVERY_OWNER_UNKNOWN'}
            if($current.CreationDate.ToUniversalTime().Ticks -eq $ticks){throw 'DAILY_LOCK_RECOVERY_OWNER_PRESENT'}
        }
        $stream.Position=0;$digest=[Security.Cryptography.SHA256]::Create()
        try {$hash=[BitConverter]::ToString($digest.ComputeHash($stream)).Replace('-','').ToLowerInvariant()}finally{$digest.Dispose()}
    } finally {$stream.Dispose()}
    if((Get-DailyDigest $Path) -cne $hash){throw 'DAILY_LOCK_RECOVERY_CHANGED'}
    [IO.File]::Move($Path,$Backup)
    if((Test-Path -LiteralPath $Path) -or (Get-DailyDigest $Backup) -cne $hash){throw 'DAILY_LOCK_RECOVERY_UNKNOWN'}
    return @{backup=$Backup;sha256=$hash;ownerPid=$record.identity.pid;ownerStartedUtcTicks=[string]$ticks;bootUtc=$Boot.ToString('o');journalRead=$false;journalChanged=$false}
}
function Repair-McpDailyAfterReboot {
    param([string]$Root,[string]$Version,[string]$OperationName,[switch]$ResumeUnchangedLock)
    $lock=Open-DailyLock $Root
    try {
        if(Test-Path -LiteralPath (Join-Path $Root 'current.json')){throw 'DAILY_RECOVERY_ALREADY_SELECTED'}
        if($OperationName -cnotmatch '^cutover-[0-9a-f]{32}$'){throw 'DAILY_RECOVERY_SCOPE_REJECTED'}
        $operation=Join-Path $Root ('operations\'+$OperationName)
        $facts=Get-DailyCutoverRecoveryFacts $operation
        if((Read-DailyJson (Join-Path $operation 'failure.json')).code -cne 'DAILY_STATE_LOCK_PRESENT'){throw 'DAILY_RECOVERY_SCOPE_REJECTED'}
        $null=Test-DailyVersion $Root $Version
        $settings=Read-DailySettingsForVersion $Root $Version
        $intent=Join-Path $operation 'state-recovery-intent.json'
        $existing=Test-Path -LiteralPath $intent
        if($existing -and -not $ResumeUnchangedLock){throw 'DAILY_STATE_RECOVERY_ALREADY_ATTEMPTED'}
        if($ResumeUnchangedLock -and -not $existing){throw 'DAILY_STATE_RECOVERY_RESUME_REJECTED'}
        Assert-DailyRecoveryStopped $Root $Version
        $path=Join-Path $settings.dataDir 'powershell-approval\approval.lock'
        $backup=$path+'.retired-'+[guid]::NewGuid().ToString('N')
        if($existing){
            $prior=Read-DailyJson $intent
            if($prior.contract -cne 'mcpcc-stopped-state-recovery-v1' -or $prior.version -cne $Version -or
                $prior.bootUtc -cne $facts.bootUtc -or $prior.automaticRetry -ne $false -or
                (Test-Path -LiteralPath (Join-Path $operation 'state-recovered.json')) -or
                -not(Test-Path -LiteralPath $path) -or (Test-Path -LiteralPath $prior.backup)){
                throw 'DAILY_STATE_RECOVERY_RESUME_REJECTED'
            }
            $backup=[string]$prior.backup
            Write-DailyNew (Join-Path $operation 'state-recovery-resume.json') @{originalIntentSha256=(Get-DailyDigest $intent);lockSha256=(Get-DailyDigest $path);backupAbsent=$true;utc=[DateTime]::UtcNow.ToString('o');automaticRetry=$false}
        }else{
            Write-DailyNew $intent @{contract='mcpcc-stopped-state-recovery-v1';version=$Version;bootUtc=$facts.bootUtc;backup=$backup;automaticRetry=$false}
        }
        $result=Move-DailyStaleApprovalLock $path $backup ([DateTime]::Parse($facts.bootUtc).ToUniversalTime())
        Write-DailyNew (Join-Path $operation 'state-recovered.json') $result
        Invoke-DailyOwner $Root $Version Stopped
        Resolve-DailyCutoverAfterReboot $Root $OperationName
        Assert-DailyNoPending $Root
        return @{phase='RECOVERED_NOT_STARTED';operation=$OperationName;backup=$backup;startupChanged=$false;dataMoved=$false}
    } finally {$lock.Dispose()}
}
function Get-McpDailyStatus([string]$Root) {
    $selector=Read-DailyJson (Join-Path $Root 'current.json')
    if($selector.contract -cne 'mcpcc-daily-current-v1'){throw 'DAILY_SELECTOR_INVALID'}
    $null=Test-DailyVersion $Root $selector.version
    return @{version=$selector.version;root=(Join-Path $Root ('versions\'+$selector.version));live='UNVERIFIED'}
}
function Initialize-McpDailySelector {
    param([string]$Root,[string]$Version,[switch]$LegacyRetired)
    if(-not $LegacyRetired){throw 'DAILY_ONE_TIME_ADOPTION_REQUIRED'}
    $lock=Open-DailyLock $Root
    try {
        if(Test-Path -LiteralPath (Join-Path $Root 'current.json')){throw 'DAILY_ALREADY_ADOPTED'}
        Assert-DailyNoPending $Root
        $null=Test-DailyVersion $Root $Version
        $s=Read-DailySettingsForVersion $Root $Version
        Invoke-DailyOwner $Root $Version Preflight
        Invoke-DailyOwner $Root $Version Stopped
        # A tray may restart the legacy runtime; require the existing singleton to be absent.
        $tray=$null
        try {$tray=[Threading.Mutex]::OpenExisting('Local\McpControlCenterTray');throw 'DAILY_LEGACY_TRAY_PRESENT'}
        catch [Threading.WaitHandleCannotBeOpenedException] {} finally {if($tray){$tray.Dispose()}}
        Write-DailyNew (Join-Path $Root 'adoption.json') @{contract='mcpcc-daily-adoption-v1';settingsSha256=(Get-DailyDigest (Join-Path $Root 'settings.json'));version=$Version}
        Set-DailySelector $Root $Version
        return @{phase='ADOPTED_NOT_STARTED';version=$Version;startupChanged=$false;dataMoved=$false}
    } finally {$lock.Dispose()}
}
function Assert-DailySettingsUnchanged([string]$Root) {
    $a=Read-DailyJson (Join-Path $Root 'adoption.json')
    if($a.settingsSha256 -cne (Get-DailyDigest (Join-Path $Root 'settings.json'))){throw 'DAILY_CONFIG_CHANGED_MIGRATION_REQUIRED'}
}
function Test-McpDailyUpdate {
    param([string]$Root,[string]$Version,[switch]$CodeOnly)
    if(-not $CodeOnly){throw 'DAILY_CODE_ONLY_REVIEW_REQUIRED'}
    Assert-DailySettingsUnchanged $Root
    $selected=Get-McpDailyStatus $Root;$old=[string]$selected.version
    $before=Test-DailyVersion $Root $old;$after=Test-DailyVersion $Root $Version
    $changed=@(if($old -cne $Version){Assert-DailyCompatible $before $after})
    # Paths/metadata only: never invoke the bearer-loading owner Preflight here.
    $null=Read-DailySettingsForVersion $Root $Version
    return @{phase='PREFLIGHT';currentVersion=$old;candidateVersion=$Version;changed=$changed;
        codeOnlyCompatible=$true;candidateFiles=@($after.files).Count;live='NOT_OPERATED';
        ownerPreflight='DEFERRED_TO_INDEPENDENT_UPDATE';activeWork='NOT_CHECKED';pendingOperations=@(Get-DailyPending $Root)}
}
function Open-DailyTransaction([string]$Root) {
    $mutex=New-Object Threading.Mutex($false,'Local\McpControlCenter.Action.codex_bridge')
    $held=$false;$file=$null
    try {
        try {$held=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$held=$true}
        if(-not $held){throw 'DAILY_ACTION_BUSY'}
        $file=Open-DailyLock $Root
        return @{mutex=$mutex;file=$file}
    } catch {if($held){$mutex.ReleaseMutex()};$mutex.Dispose();throw}
}
function Close-DailyTransaction($Transaction) {
    if($Transaction){$Transaction.file.Dispose();$Transaction.mutex.ReleaseMutex();$Transaction.mutex.Dispose()}
}
function Get-DailyCode($ErrorRecord) {
    $code=([string]$ErrorRecord.Exception.Message -split ':')[0]
    if($code -cnotmatch '^[A-Z][A-Z0-9_]+$'){return 'DAILY_IO_OR_OWNER_FAILED'}
    return $code
}
function Get-DailyOperationPath([string]$Root,[string]$OperationId) {
    if($OperationId -cnotmatch '^[0-9a-f]{32}$'){throw 'DAILY_OPERATION_INVALID'}
    $path=Join-Path $Root ('operations\'+$OperationId);Assert-DailyPath $path
    return $path
}
function Write-DailyEvent([string]$Root,[string]$OperationId,[string]$Kind,$Value) {
    $op=Get-DailyOperationPath $Root $OperationId
    Write-DailyNew (Join-Path $op ($Kind+'-'+[DateTime]::UtcNow.Ticks+'-'+[guid]::NewGuid().ToString('N')+'.json')) $Value
}
function Get-DailyResult([string]$Operation) {
    $paths=@(Get-ChildItem -LiteralPath $Operation -Filter 'resolution*.json' -File|Sort-Object Name -Descending|ForEach-Object {$_.FullName})
    $paths+=Join-Path $Operation 'terminal.json'
    foreach($path in $paths){
        if(Test-Path -LiteralPath $path){
            Assert-DailyPath $path
            if((Get-Item -LiteralPath $path).Length -gt 16000000){throw 'DAILY_JSON_LIMIT'}
            $text=Get-Content -LiteralPath $path -Raw -Encoding UTF8
            # Historical partial publication is evidence to re-observe, not a
            # permanent gate. IO/permission failures above still propagate.
            try {$r=$text|ConvertFrom-Json}catch{continue}
            if($r -and $r.PSObject.Properties['phase'] -and $r.phase -in @('ACCEPTED','ROLLED_BACK','REJECTED','NOT_APPLIED','SUPERSEDED','DEGRADED')){return $r}
        }
    }
    return $null
}
function Get-DailyPending([string]$Root) {
    $ops=Join-Path $Root 'operations'
    if(-not(Test-Path -LiteralPath $ops)){return}
    foreach($op in @(Get-ChildItem -LiteralPath $ops -Directory|Sort-Object Name)){
        if(Get-DailyResult $op.FullName){continue}
        if($op.Name -cmatch '^cutover-[0-9a-f]{32}$'){
            Assert-DailyCutoverRebootRecovery $op.FullName
            continue
        }
        if($op.Name -cnotmatch '^[0-9a-f]{32}$'){throw 'DAILY_OPERATION_INVALID'}
        # A remote reservation precedes preparation, which has no lifecycle
        # authority. Resume it only through its original request; no invented
        # NOT_APPLIED terminal may consume its stable operation ID.
        if((Test-Path -LiteralPath (Join-Path $op.FullName 'request.json')) -and -not(Test-Path -LiteralPath (Join-Path $op.FullName 'intent.json'))){continue}
        $op.Name
    }
}
function Test-DailyProcessAlive($Identity) {
    $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$Identity.pid) -ErrorAction Stop
    if(-not $p){return $false}
    if($null -eq $p.CreationDate){throw 'DAILY_PROCESS_IDENTITY_UNKNOWN'}
    $actual=$p.CreationDate.ToUniversalTime().Ticks;$expected=[DateTime]::Parse($Identity.startedUtc).ToUniversalTime().Ticks
    # CIM exposes microseconds; native/.NET creation times expose 100 ns ticks.
    return ($actual-($actual%10)) -eq ($expected-($expected%10))
}
function Assert-DailyChildrenExited([string]$Operation) {
    foreach($file in @(Get-ChildItem -LiteralPath $Operation -Filter 'child-*.json' -File)){
        if(Test-DailyProcessAlive (Read-DailyJson $file.FullName)){throw 'DAILY_OWNER_CHILD_STILL_RUNNING'}
    }
}
function Complete-DailyOperation([string]$Root,[string]$OperationId,[string]$Phase,[string]$Requested,$Evidence,[string]$Code) {
    $op=Get-DailyOperationPath $Root $OperationId
    $selected=(Get-McpDailyStatus $Root).version
    $result=@{phase=$Phase;operationId=$OperationId;requestedVersion=$Requested;version=$selected;selectedVersion=$selected;
        observedRuntimeVersion=$(if($Evidence -and $Evidence.PSObject.Properties['version']){$Evidence.version}elseif($Evidence -is [hashtable] -and $Evidence.ContainsKey('version')){$Evidence.version}else{$null});
        observedBuildId=$(if($Evidence -and $Evidence.PSObject.Properties['buildId']){$Evidence.buildId}elseif($Evidence -is [hashtable] -and $Evidence.ContainsKey('buildId')){$Evidence.buildId}else{$null});
        preparedBuildId=$(if($Evidence -and $Evidence.PSObject.Properties['preparedBuildId']){$Evidence.preparedBuildId}elseif($Evidence -is [hashtable] -and $Evidence.ContainsKey('preparedBuildId')){$Evidence.preparedBuildId}else{$null});
        evidence=$Evidence;code=$Code;recoveryRequired=($Phase -eq 'RECOVERY_REQUIRED');receipt=$op;utc=[DateTime]::UtcNow.ToString('o')}
    Write-DailyEvent $Root $OperationId 'reconciliation' $result
    if($Phase -eq 'RECOVERY_REQUIRED'){
        if(-not(Test-Path -LiteralPath (Join-Path $op 'terminal.json'))){Write-DailyNew (Join-Path $op 'terminal.json') $result}
    }else{
        $name=if(Test-Path -LiteralPath (Join-Path $op 'terminal.json')){'resolution.json'}else{'terminal.json'}
        if(Test-Path -LiteralPath (Join-Path $op $name)){$name='resolution-'+[DateTime]::UtcNow.Ticks+'-'+[guid]::NewGuid().ToString('N')+'.json'}
        Write-DailyNew (Join-Path $op $name) $result
    }
    return $result
}
function Test-DailyCoreStopped($Observation) {
    return $Observation.roles.server.canMutate -and $Observation.roles.server.state -ceq 'Stopped'
}
function Stop-DailyVersion([string]$Root,[string]$Version,[string]$OperationId) {
    $before=Invoke-DailyOwner $Root $Version Observe
    Write-DailyEvent $Root $OperationId 'before-stop' $before
    if(-not(Test-DailyCoreStopped $before)){
        try {$null=Invoke-DailyOwner $Root $Version Stop}
        catch {
            Write-DailyEvent $Root $OperationId 'owner-stop-failure' @{code=(Get-DailyCode $_)}
            Assert-DailyChildrenExited (Get-DailyOperationPath $Root $OperationId)
            $now=Invoke-DailyOwner $Root $Version Observe
            if(-not(Test-DailyCoreStopped $now)){throw}
        }
    }
    # Always use current source for recovery: old owner may have stopped the core
    # and returned its obsolete lock-presence error before completing the tunnel.
    $stopped=Invoke-DailyOwner $Root $Version RecoverStopped
    Write-DailyEvent $Root $OperationId 'stopped' $stopped
    $null=Invoke-DailyOwner $Root $Version Stopped
}
function Restore-DailyOperation([string]$Root,[string]$OperationId,$Intent,[string]$Code) {
    $op=Get-DailyOperationPath $Root $OperationId
    if(-not(Test-Path -LiteralPath (Join-Path $op 'rollback-intent.json'))){Write-DailyNew (Join-Path $op 'rollback-intent.json') @{code=$Code;utc=[DateTime]::UtcNow.ToString('o')}}
    $selected=(Get-McpDailyStatus $Root).version
    if($selected -notin @($Intent.old,$Intent.next)){throw 'DAILY_NEWER_SELECTION_CONFLICT'}
    $old=Invoke-DailyOwner $Root $Intent.old Observe
    if($selected -ceq $Intent.old -and $old.coreReady){
        try {$e=Invoke-DailyOwner $Root $Intent.old Verify;return Complete-DailyOperation $Root $OperationId ROLLED_BACK $Intent.next $e $Code}
        catch {return Complete-DailyOperation $Root $OperationId DEGRADED $Intent.next $old (Get-DailyCode $_)}
    }
    Stop-DailyVersion $Root $selected $OperationId
    $null=Test-DailyVersion $Root $Intent.old;Assert-DailySettingsUnchanged $Root
    if((Get-McpDailyStatus $Root).version -cne $selected){throw 'DAILY_SELECTOR_CHANGED'}
    if($selected -cne $Intent.old){Set-DailySelector $Root $Intent.old}
    $null=Invoke-DailyOwner $Root $Intent.old Start
    try {$e=Invoke-DailyOwner $Root $Intent.old Verify;return Complete-DailyOperation $Root $OperationId ROLLED_BACK $Intent.next $e $Code}
    catch {
        $old=Invoke-DailyOwner $Root $Intent.old Observe
        if($old.coreReady){return Complete-DailyOperation $Root $OperationId DEGRADED $Intent.next $old (Get-DailyCode $_)}
        throw
    }
}
function Assert-DailyRequest($Request,[string]$OperationId,[string]$Version,[string]$SourceDigest) {
    if($Request.operationId -cne $OperationId -or $Request.version -cnotmatch '^[a-z0-9][a-z0-9_-]{0,47}$' -or
        ($Version -and ($Request.version -cne $Version -or [string]$Request.sourceDigest -cne $SourceDigest))){throw 'DAILY_REQUEST_CONFLICT'}
}
function Resume-DailyOperation([string]$Root,[string]$OperationId,[switch]$New) {
    $op=Get-DailyOperationPath $Root $OperationId
    if(-not(Test-Path -LiteralPath $op -PathType Container)){throw 'DAILY_OPERATION_NOT_FOUND'}
    $final=Get-DailyResult $op
    if($final){return $final}
    $script:DailyOperationId=$OperationId
    $intent=$null;$requested='';$phase='OBSERVING'
    try {
        Assert-DailyChildrenExited $op
        Assert-DailySettingsUnchanged $Root
        $selected=(Get-McpDailyStatus $Root).version
        if(Test-Path -LiteralPath (Join-Path $op 'intent.json')){$intent=Read-DailyJson (Join-Path $op 'intent.json')}
        if(-not $intent){
            $requestPath=Join-Path $op 'request.json'
            if(Test-Path -LiteralPath $requestPath){
                $request=Read-DailyJson $requestPath
                Assert-DailyRequest $request $OperationId
                $requested=[string]$request.version
            }
            # Recover preparation against the immutable staged artifacts, never
            # today's editable source. No intent means no lifecycle was dispatched.
            $code='DAILY_INTENT_NOT_PUBLISHED'
            $candidate=Join-Path $Root ('versions/'+$requested)
            if($requested -and (Test-Path -LiteralPath $candidate)){
                $before=Test-DailyVersion $Root $selected
                $after=Test-DailyVersion $Root $requested
                try {$null=Assert-DailyCompatible $before $after}
                catch {if((Get-DailyCode $_) -cne 'DAILY_NO_CODE_CHANGE'){throw};$code='DAILY_NO_CODE_CHANGE'}
            }
            # Directory creation can precede both request and intent publication.
            # With neither record, no requested version is known or invented.
            $ready=Invoke-DailyOwner $Root $selected Verify
            return Complete-DailyOperation $Root $OperationId NOT_APPLIED $requested $ready $code
        }
        if($intent.old -cnotmatch '^[a-z0-9][a-z0-9_-]{0,47}$' -or $intent.next -cnotmatch '^[a-z0-9][a-z0-9_-]{0,47}$'){throw 'DAILY_INTENT_INVALID'}
        if($selected -notin @($intent.old,$intent.next)){
            $ready=Invoke-DailyOwner $Root $selected Verify
            return Complete-DailyOperation $Root $OperationId SUPERSEDED $intent.next $ready 'DAILY_HEALTHY_LATER_VERSION'
        }
        if(Test-Path -LiteralPath (Join-Path $op 'rollback-intent.json')){
            $prior=Read-DailyJson (Join-Path $op 'rollback-intent.json')
            return Restore-DailyOperation $Root $OperationId $intent $prior.code
        }
        $observation=Invoke-DailyOwner $Root $selected Observe
        Write-DailyEvent $Root $OperationId 'observation' $observation
        if(-not $New -and $selected -ceq $intent.old -and $observation.coreReady){
            $ready=Invoke-DailyOwner $Root $selected Verify
            return Complete-DailyOperation $Root $OperationId NOT_APPLIED $intent.next $ready 'DAILY_OLD_VERSION_AVAILABLE'
        }
        if($selected -ceq $intent.next -and $observation.coreReady){
            $phase='VERIFYING'
            $ready=Invoke-DailyOwner $Root $selected Verify
            return Complete-DailyOperation $Root $OperationId ACCEPTED $intent.next $ready $null
        }
        # A stopped old version or an already selected target must recover to the
        # old release if the next candidate can no longer be used.
        if($selected -ceq $intent.next -or (Test-DailyCoreStopped $observation)){$phase='RESUMING_STOPPED'}
        $null=Test-DailyVersion $Root $intent.next
        if($intent.PSObject.Properties['candidateSha256'] -and
            (Get-DailyDigest (Join-Path $Root ('versions\'+$intent.next+'\daily-release.json'))) -cne $intent.candidateSha256){throw 'DAILY_CANDIDATE_CHANGED'}
        if($selected -ceq $intent.old){
            $phase='STOPPING'
            Stop-DailyVersion $Root $selected $OperationId
            $phase='SELECTING'
            $null=Test-DailyVersion $Root $intent.next;Assert-DailySettingsUnchanged $Root
            if((Get-McpDailyStatus $Root).version -cne $selected){throw 'DAILY_SELECTOR_CHANGED'}
            Write-DailyEvent $Root $OperationId 'select-intent' @{from=$selected;to=$intent.next}
            Set-DailySelector $Root $intent.next
        }elseif(Test-DailyCoreStopped $observation){
            $null=Invoke-DailyOwner $Root $selected RecoverStopped
        }else{$phase='VERIFYING';throw 'DAILY_TARGET_OWNER_NOT_READY'}
        $phase='STARTING'
        $null=Invoke-DailyOwner $Root $intent.next Start
        $phase='VERIFYING'
        $ready=Invoke-DailyOwner $Root $intent.next Verify
        return Complete-DailyOperation $Root $OperationId ACCEPTED $intent.next $ready $null
    } catch {
        $code=Get-DailyCode $_
        Write-DailyEvent $Root $OperationId 'failure' @{phase=$phase;code=$code}
        if(-not(Test-Path -LiteralPath (Join-Path $op 'failure.json'))){Write-DailyNew (Join-Path $op 'failure.json') @{phase=$phase;code=$code}}
        try {
            Assert-DailyChildrenExited $op
            if($intent -and $phase -in @('STARTING','VERIFYING','SELECTING','RESUMING_STOPPED')){return Restore-DailyOperation $Root $OperationId $intent $code}
            if($intent -and $phase -eq 'STOPPING'){
                $old=Invoke-DailyOwner $Root $intent.old Observe
                if($old.coreReady){return Complete-DailyOperation $Root $OperationId REJECTED $intent.next $old $code}
            }
        } catch {Write-DailyEvent $Root $OperationId 'recovery-failure' @{code=(Get-DailyCode $_)}}
        return Complete-DailyOperation $Root $OperationId RECOVERY_REQUIRED $(if($intent){$intent.next}else{$requested}) $null $code
    } finally {$script:DailyOperationId=$null}
}
function Build-DailyCandidate([string]$Source) {
    Assert-DailyPath $Source
    $bridge=Join-Path $Source 'codex_bridge'
    $compiler=Join-Path $bridge 'node_modules\typescript\bin\tsc'
    Assert-DailyPath $compiler
    if(-not(Test-Path -LiteralPath $compiler -PathType Leaf)){throw 'DAILY_BUILD_COMPILER_MISSING'}
    $node=(Get-Command node.exe -ErrorAction Stop).Source
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=$node;$info.Arguments='"'+$compiler+'" -p tsconfig.json';$info.WorkingDirectory=$bridge
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $p=$null
    try {
        Initialize-DailyChildNative;$p=[CbDailyChild]::Start($info)
        $timeout=120000
        $fixtureTimeout=Get-Variable -Name DailyBuildTimeoutMs -Scope Script -ErrorAction SilentlyContinue
        if($fixtureTimeout){$timeout=[int]$fixtureTimeout.Value}
        $null=Read-DailyOwnerOutput $p $timeout
        if($p.ExitCode -ne 0){throw 'DAILY_BUILD_FAILED'}
    } finally {if($p){$p.Dispose()}}
}
function Repair-McpDailyOperation {
    param([string]$Root,[string]$OperationId,[string]$Version,[string]$SourceDigest)
    $script:DailyTransaction=Open-DailyTransaction $Root
    try {
        $op=Get-DailyOperationPath $Root $OperationId
        $requestPath=Join-Path $op 'request.json'
        if($Version -or (Test-Path -LiteralPath $requestPath)){
            Assert-DailyRequest (Read-DailyJson $requestPath) $OperationId $Version $SourceDigest
        }
        return Resume-DailyOperation $Root $OperationId
    }
    finally {Close-DailyTransaction $script:DailyTransaction;$script:DailyTransaction=$null}
}
function Get-DailySourcePin([string]$Source) {
    Import-Module (Join-Path $PSScriptRoot 'McpControlCenter.WorkspaceUpdate.psm1') -Force
    $definition=Get-McpCcUpdateDefinition $Source 'codex_bridge'
    return Get-McpCcUpdateDigest $Source $definition
}
function Assert-DailySourcePin([string]$Source,[string]$Expected) {
    if(-not $Expected){return}
    if(-not $Source){throw 'DAILY_SOURCE_ROOT_REQUIRED'}
    if((Get-DailySourcePin $Source) -cne $Expected){throw 'SOURCE_CHANGED_USE_NEW_REQUEST'}
}
function Invoke-McpDailyUpdate {
    param([string]$Root,[string]$Version,[switch]$CodeOnly,[string]$CandidateRoot,[string]$OperationId,[string]$SourceDigest)
    if(-not $CodeOnly){throw 'DAILY_CODE_ONLY_REVIEW_REQUIRED'}
    if($Version -cnotmatch '^[a-z0-9][a-z0-9_-]{0,47}$'){throw 'DAILY_VERSION_INVALID'}
    $script:DailyTransaction=Open-DailyTransaction $Root
    try {
        if($OperationId){
            $reserved=Get-DailyOperationPath $Root $OperationId
            [void][IO.Directory]::CreateDirectory($reserved)
            $requestPath=Join-Path $reserved 'request.json'
            if(Test-Path -LiteralPath $requestPath){
                $request=Read-DailyJson $requestPath
                Assert-DailyRequest $request $OperationId $Version $SourceDigest
            }else{
                if((Get-DailyResult $reserved) -or (Test-Path -LiteralPath (Join-Path $reserved 'intent.json'))){throw 'DAILY_REQUEST_BINDING_MISSING'}
                Write-DailyNew $requestPath @{operationId=$OperationId;version=$Version;sourceDigest=$SourceDigest;createdUtc=[DateTime]::UtcNow.ToString('o')}
            }
            $final=Get-DailyResult $reserved
            if($final){return $final}
            if(Test-Path -LiteralPath (Join-Path $reserved 'intent.json')){return Resume-DailyOperation $Root $OperationId}
        }
        $recovered=@()
        foreach($id in @(Get-DailyPending $Root)){
            $r=Resume-DailyOperation $Root $id
            $recovered+=,$r
            if($r.phase -eq 'RECOVERY_REQUIRED'){return $r}
        }
        if($CandidateRoot){
            Assert-DailySourcePin $CandidateRoot $SourceDigest
            Build-DailyCandidate $CandidateRoot
            Assert-DailySourcePin $CandidateRoot $SourceDigest
            $null=New-McpDailyCandidate -Root $Root -Source $CandidateRoot -Version $Version -ReuseEquivalent
        }
        Assert-DailySourcePin $CandidateRoot $SourceDigest
        try {$preflight=Test-McpDailyUpdate -Root $Root -Version $Version -CodeOnly}
        catch {
            if((Get-DailyCode $_) -cne 'DAILY_NO_CODE_CHANGE'){throw}
            # This exact read-only preflight result is not an uncertain dispatch.
            # Publish it through the same canonical operation, with loaded proof.
            if(-not $OperationId){
                $OperationId=[guid]::NewGuid().ToString('N')
                $reserved=Get-DailyOperationPath $Root $OperationId
                [void][IO.Directory]::CreateDirectory($reserved)
                Write-DailyNew (Join-Path $reserved 'request.json') @{operationId=$OperationId;version=$Version;sourceDigest=$SourceDigest;createdUtc=[DateTime]::UtcNow.ToString('o')}
            }
            return Resume-DailyOperation $Root $OperationId
        }
        $old=[string]$preflight.currentVersion
        if($old -ceq $Version -and -not $OperationId){
            $ready=Invoke-DailyOwner $Root $Version Verify
            $same=@($recovered|Where-Object {$_.phase -eq 'ACCEPTED' -and $_.requestedVersion -ceq $Version})
            if($same.Count){return $same[-1]}
            return @{phase='ALREADY_SELECTED';version=$Version;evidence=$ready;recoveredOperations=$recovered}
        }
        $null=Invoke-DailyOwner $Root $Version Preflight
        Assert-DailySourcePin $CandidateRoot $SourceDigest
        $id=if($OperationId){$OperationId}else{[guid]::NewGuid().ToString('N')};$op=Get-DailyOperationPath $Root $id
        [void][IO.Directory]::CreateDirectory($op)
        Write-DailyNew (Join-Path $op 'intent.json') @{old=$old;next=$Version;changed=@($preflight.changed);createdUtc=[DateTime]::UtcNow.ToString('o');
            updater=@{pid=$PID;startedUtc=(Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o')};
            candidateSha256=(Get-DailyDigest (Join-Path $Root ('versions\'+$Version+'\daily-release.json')))}
        return Resume-DailyOperation $Root $id -New
    } finally {Close-DailyTransaction $script:DailyTransaction;$script:DailyTransaction=$null}
}
function Get-McpDailyOperationStatus([string]$Root,[string]$OperationId) {
    $op=Get-DailyOperationPath $Root $OperationId
    if(-not(Test-Path -LiteralPath $op)){throw 'DAILY_OPERATION_NOT_FOUND'}
    $result=Get-DailyResult $op;$updater=$false
    if(Test-Path -LiteralPath (Join-Path $op 'intent.json')){
        $intent=Read-DailyJson (Join-Path $op 'intent.json')
        if($intent.PSObject.Properties['updater']){$updater=Test-DailyProcessAlive $intent.updater}
    }
    $observations=@(Get-ChildItem -LiteralPath $op -Filter 'reconciliation-*.json' -File|Sort-Object Name)
    if(-not $result -and $observations.Count){$result=Read-DailyJson $observations[-1].FullName}
    return @{operationId=$OperationId;updaterAlive=$updater;recoveryRequired=($null -eq (Get-DailyResult $op));
        result=$result;selectedVersion=(Get-McpDailyStatus $Root).version;live='UNVERIFIED'}
}
function Start-McpDailyCurrent([string]$Root) {
    $script:DailyTransaction=Open-DailyTransaction $Root
    try {
        foreach($id in @(Get-DailyPending $Root)){
            $recovered=Resume-DailyOperation $Root $id
            if($recovered.phase -eq 'RECOVERY_REQUIRED'){return $recovered}
        }
        Assert-DailySettingsUnchanged $Root
        $current=Get-McpDailyStatus $Root
        $null=Read-DailySettingsForVersion $Root $current.version
        $null=Invoke-DailyOwner $Root $current.version Preflight
        $null=Invoke-DailyOwner $Root $current.version Start
        $null=Invoke-DailyOwner $Root $current.version Verify
        return @{phase='READY';version=$current.version}
    } finally {Close-DailyTransaction $script:DailyTransaction;$script:DailyTransaction=$null}
}
Export-ModuleMember -Function New-McpDailyCandidate,Initialize-McpDailySelector,Invoke-McpDailyUpdate,Start-McpDailyCurrent,Get-McpDailyStatus,Repair-McpDailyAfterReboot,Test-McpDailyUpdate,Repair-McpDailyOperation,Get-McpDailyOperationStatus
