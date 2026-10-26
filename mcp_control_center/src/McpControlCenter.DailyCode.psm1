Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$script:Utf8=New-Object Text.UTF8Encoding($false)

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
    $bytes=$script:Utf8.GetBytes(($Value|ConvertTo-Json -Depth 12))
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
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
function Get-DailyFiles([string]$Root,[switch]$AllowEmptyRuntimeInbox) {
    Assert-DailyPath $Root
    $queue=New-Object 'Collections.Generic.Stack[string]';$queue.Push($Root)
    $rows=New-Object 'Collections.Generic.List[object]'
    while($queue.Count) {
        foreach($f in Get-ChildItem -LiteralPath $queue.Pop() -Force) {
            if($f.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'DAILY_REPARSE_REJECTED'}
            $relative=$f.FullName.Substring($Root.Length+1).Replace('\','/')
            if($relative -in @('daily-release.json','daily-mode.json')){continue}
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
    $actual=@(Get-DailyFiles $path -AllowEmptyRuntimeInbox)
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
    param([string]$Root,[string]$Source,[string]$Version)
    if(-not $Source -or $Version -cnotmatch '^[a-z0-9][a-z0-9_-]{0,47}$'){throw 'DAILY_SOURCE_VERSION_REQUIRED'}
    $Root=[IO.Path]::GetFullPath($Root).TrimEnd('\');$Source=[IO.Path]::GetFullPath($Source).TrimEnd('\')
    Assert-DailyPath $Root;Assert-DailyPath $Source
    if(Test-Path -LiteralPath (Join-Path $Source 'mcp_control_center\config\installed-release.json')){throw 'DAILY_PROTECTED_MIGRATION_REQUIRED'}
    $target=Join-Path $Root ('versions\'+$Version)
    if(Test-Path -LiteralPath $target){throw 'DAILY_VERSION_EXISTS'}
    # Explicit code trees only. Never recursively copy the checkout, Runtime or private state.
    # Preflight every tree using names/metadata before copying or hashing any file.
    $items=New-Object 'Collections.Generic.List[object]'
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
                    Assert-DailyCodePath ($child.FullName.Substring($Source.Length+1).Replace('\','/'))
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
            $p -notmatch '^(codex_bridge/(src|dist/src|web|scripts)/.+\.(ts|js|mjs|map|html|css|svg|ps1|psm1|cs|vbs)|mcp_control_center/(src|scripts)/.+\.(ps1|psm1|cs|vbs))$') {
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
    $entry=Join-Path $release 'codex_bridge\scripts\daily-code-owner.ps1'
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
    $info.Arguments='-NoProfile -NonInteractive -File "'+$entry+'" -ReleaseRoot "'+$release+'" -Action '+$Action
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $p=New-Object Diagnostics.Process;$p.StartInfo=$info
    try {
        if(-not $p.Start()){throw 'DAILY_OWNER_NOT_STARTED'}
        $stdout=$p.StandardOutput.ReadToEndAsync();$stderr=$p.StandardError.ReadToEndAsync()
        if(-not $p.WaitForExit(180000)){throw 'DAILY_OWNER_TIMEOUT_UNKNOWN'}
        $output=$stdout.GetAwaiter().GetResult();$err=$stderr.GetAwaiter().GetResult()
        if($output.Length -gt 16384 -or $err.Length){throw 'DAILY_OWNER_OUTPUT_UNKNOWN'}
        $result=$output|ConvertFrom-Json
        if($result.ok -ne $true -or $p.ExitCode -ne 0){throw ([string]$result.code)}
    } finally {$p.Dispose()} # Never kill a timed-out controller; preserve UNKNOWN.
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
function Invoke-McpDailyUpdate {
    param([string]$Root,[string]$Version,[switch]$CodeOnly)
    if(-not $CodeOnly){throw 'DAILY_CODE_ONLY_REVIEW_REQUIRED'}
    $lock=Open-DailyLock $Root
    try {
        Assert-DailyNoPending $Root;Assert-DailySettingsUnchanged $Root
        $selected=Get-McpDailyStatus $Root;$old=[string]$selected.version
        if($old -ceq $Version){return @{phase='ALREADY_SELECTED';version=$Version;live='UNVERIFIED'}}
        $before=Test-DailyVersion $Root $old;$after=Test-DailyVersion $Root $Version
        $changed=@(Assert-DailyCompatible $before $after)
        $null=Read-DailySettingsForVersion $Root $Version
        Invoke-DailyOwner $Root $Version Preflight
        $ops=Join-Path $Root 'operations';[void][IO.Directory]::CreateDirectory($ops)
        $op=Join-Path $ops ([guid]::NewGuid().ToString('N'));[void][IO.Directory]::CreateDirectory($op)
        Write-DailyNew (Join-Path $op 'intent.json') @{old=$old;next=$Version;changed=$changed;createdUtc=[DateTime]::UtcNow.ToString('o')}
        $phase='STOPPING';$selectedNew=$false;$oldStopped=$false
        try {
            Write-DailyNew (Join-Path $op '01-stop-intent.json') @{phase=$phase}
            Invoke-DailyOwner $Root $old Stop
            Invoke-DailyOwner $Root $old Stopped;$oldStopped=$true
            # Recheck code and config after drain, immediately before selector mutation.
            $null=Test-DailyVersion $Root $Version;Assert-DailySettingsUnchanged $Root
            $phase='SELECTING';Write-DailyNew (Join-Path $op '03-select-intent.json') @{phase=$phase}
            Set-DailySelector $Root $Version;$selectedNew=$true
            $phase='STARTING'
            Invoke-DailyOwner $Root $Version Start
            $phase='VERIFYING';Invoke-DailyOwner $Root $Version Ready
            Write-DailyNew (Join-Path $op 'terminal.json') @{phase='ACCEPTED';version=$Version}
            return @{phase='ACCEPTED';version=$Version;receipt=$op}
        } catch {
            $failure=([string]$_.Exception.Message -split ':')[0]
            if($failure -cnotmatch '^[A-Z][A-Z0-9_]+$'){$failure='DAILY_FAILED'}
            Write-DailyNew (Join-Path $op 'failure.json') @{phase=$phase;code=$failure}
            # Any ambiguous side effect or interruption is quarantined. Never replay on reentry.
            if($failure -match 'UNKNOWN|TIMEOUT' -or $phase -eq 'SELECTING') {throw ('DAILY_INTERRUPTED_UNKNOWN_DO_NOT_RETRY: '+$op)}
            if(-not $oldStopped) {
                if($failure -in @('ACTIVE_WORK_PRESENT','OWNERSHIP_MISMATCH','BLOCKED_GRACEFUL_SHUTDOWN_UNAVAILABLE','ACTION_BUSY')) {
                    Write-DailyNew (Join-Path $op 'terminal.json') @{phase='REJECTED';code=$failure}
                }
                throw
            }
            try {
                Write-DailyNew (Join-Path $op '04-rollback-intent.json') @{phase='ROLLING_BACK';code=$failure}
                if($selectedNew) {
                    Invoke-DailyOwner $Root $Version Stop
                    Invoke-DailyOwner $Root $Version Stopped
                }
                $null=Test-DailyVersion $Root $old;Assert-DailySettingsUnchanged $Root
                Set-DailySelector $Root $old
                Invoke-DailyOwner $Root $old Start
                Invoke-DailyOwner $Root $old Ready
                Write-DailyNew (Join-Path $op 'terminal.json') @{phase='ROLLED_BACK';version=$old;failedVersion=$Version;code=$failure}
            } catch {
                Write-DailyNew (Join-Path $op 'rollback-failed.json') @{phase='UNKNOWN';code='DAILY_ROLLBACK_UNVERIFIED'}
                throw ('DAILY_ROLLBACK_UNVERIFIED_DO_NOT_RETRY: '+$op)
            }
            throw ('DAILY_UPDATE_FAILED_ROLLED_BACK: '+$op)
        }
    } finally {$lock.Dispose()}
}
function Start-McpDailyCurrent([string]$Root) {
    $lock=Open-DailyLock $Root
    try {
        Assert-DailyNoPending $Root;Assert-DailySettingsUnchanged $Root
        $current=Get-McpDailyStatus $Root
        $null=Read-DailySettingsForVersion $Root $current.version
        Invoke-DailyOwner $Root $current.version Preflight
        Invoke-DailyOwner $Root $current.version Start
        Invoke-DailyOwner $Root $current.version Ready
        return @{phase='READY';version=$current.version}
    } finally {$lock.Dispose()}
}
Export-ModuleMember -Function New-McpDailyCandidate,Initialize-McpDailySelector,Invoke-McpDailyUpdate,Start-McpDailyCurrent,Get-McpDailyStatus,Repair-McpDailyAfterReboot
