Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

function New-EnglishStudyRuntimeContext {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [Parameter(Mandatory = $true)][string]$HubRoot,
        [string]$HostName = "127.0.0.1",
        [int]$McpPort = 18886,
        [int]$HubPort = 18887,
        [string]$NodePath,
        [string]$PythonPath,
        [string[]]$HubArguments,
        [string]$HubIdentity,
        [string]$TunnelClientPath,
        [string]$TunnelProfileDir,
        [string]$TunnelProfile = "english-study",
        [string]$TunnelHealthUrl = "http://127.0.0.1:18888",
        [string]$TunnelArguments,
        [string]$TunnelIdentity,
        [string]$KeyStorePath,
        [string]$SecretPath,
        [int]$ReadyTimeoutSeconds = 30,
        [int[]]$TunnelRecoveryDelaysSeconds = @(15, 30, 60)
    )
    $root = (Resolve-Path -LiteralPath $ProjectRoot).Path
    $hub = (Resolve-Path -LiteralPath $HubRoot).Path
    $node = if ([string]::IsNullOrWhiteSpace($NodePath)) { (Get-Command node.exe -ErrorAction Stop).Source } else { [IO.Path]::GetFullPath($NodePath) }
    $python = if ([string]::IsNullOrWhiteSpace($PythonPath)) { Join-Path $hub ".venv\Scripts\python.exe" } else { [IO.Path]::GetFullPath($PythonPath) }
    if ([string]::IsNullOrWhiteSpace($TunnelClientPath)) { $TunnelClientPath = Join-Path $root "vendor\tunnel-client\tunnel-client.exe" }
    if ([string]::IsNullOrWhiteSpace($TunnelProfileDir)) { $TunnelProfileDir = Join-Path $root ".tunnel-client" }
    if ([string]::IsNullOrWhiteSpace($KeyStorePath)) { $KeyStorePath = Join-Path $root "scripts\key-store.ps1" }
    if ([string]::IsNullOrWhiteSpace($SecretPath)) { $SecretPath = Join-Path $root ".secrets\control-plane-api-key.dpapi" }
    $tunnelUri = [Uri]$TunnelHealthUrl
    if ($HostName -notin @("127.0.0.1", "localhost", "::1", "[::1]") -or $tunnelUri.Host -notin @("127.0.0.1", "localhost", "::1", "[::1]")) {
        throw "Runtime endpoints must use loopback."
    }
    $runtimeDir = Join-Path $root ".tmp"
    if ($null -eq $HubArguments -or $HubArguments.Count -eq 0) { $HubArguments = @("-m", "english_study_hub", "serve", "--host", $HostName, "--port", [string]$HubPort) }
    if ([string]::IsNullOrWhiteSpace($HubIdentity)) { $HubIdentity = "-m english_study_hub serve" }
    if ([string]::IsNullOrWhiteSpace($TunnelIdentity)) { $TunnelIdentity = $TunnelProfile }
    if ([string]::IsNullOrWhiteSpace($TunnelArguments)) {
        $TunnelArguments = "run --profile-dir `"$([IO.Path]::GetFullPath($TunnelProfileDir))`" --profile `"$TunnelProfile`" --log.file `"$(Join-Path $runtimeDir 'tunnel-client.log')`" --pid.file `"$(Join-Path $runtimeDir 'tunnel-client.pid')`""
    }
    [pscustomobject]@{
        projectRoot = $root
        hubRoot = $hub
        hostName = $HostName
        mcpPort = $McpPort
        hubPort = $HubPort
        readyTimeoutSeconds = $ReadyTimeoutSeconds
        nodePath = $node
        pythonPath = $python
        mcpEntry = Join-Path $root "dist\src\http-main.js"
        runtimeDir = $runtimeDir
        hubPidFile = Join-Path $root ".tmp\english-study-hub.pid"
        hubOwnerFile = Join-Path $root ".tmp\english-study-hub.owner.json"
        mcpPidFile = Join-Path $root ".tmp\english-study-mcp.pid"
        mcpOwnerFile = Join-Path $root ".tmp\english-study-mcp.owner.json"
        tunnelPidFile = Join-Path $root ".tmp\tunnel-client.pid"
        tunnelOwnerFile = Join-Path $root ".tmp\tunnel-client.owner.json"
        hubArguments = @($HubArguments)
        hubIdentity = $HubIdentity
        mcpIdentity = Join-Path $root "dist\src\http-main.js"
        hubHealth = "http://$HostName`:$HubPort/health"
        mcpHealth = "http://$HostName`:$McpPort/health"
        tunnelClientPath = [IO.Path]::GetFullPath($TunnelClientPath)
        tunnelProfileDir = [IO.Path]::GetFullPath($TunnelProfileDir)
        tunnelProfilePath = Join-Path ([IO.Path]::GetFullPath($TunnelProfileDir)) "$TunnelProfile.yaml"
        tunnelHealthUrl = $TunnelHealthUrl.TrimEnd('/')
        tunnelHealthPort = $(if ($tunnelUri.IsDefaultPort) { 80 } else { $tunnelUri.Port })
        tunnelArguments = $TunnelArguments
        tunnelIdentity = $TunnelIdentity
        keyStorePath = [IO.Path]::GetFullPath($KeyStorePath)
        secretPath = [IO.Path]::GetFullPath($SecretPath)
        tunnelRecoveryDelaysSeconds = @($TunnelRecoveryDelaysSeconds)
    }
}

function Read-EnglishStudyPid {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $raw = (Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue).Trim()
    $pidValue = 0
    if (-not [int]::TryParse($raw, [ref]$pidValue) -or $pidValue -le 0) { return $null }
    return $pidValue
}

$script:EnglishStudyUtf8NoBom = New-Object Text.UTF8Encoding($false)

function Write-EnglishStudyAtomicText {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Value)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    $temporary = "$Path.tmp.${PID}.$([Guid]::NewGuid().ToString('N'))"
    try {
        [IO.File]::WriteAllText($temporary, $Value, $script:EnglishStudyUtf8NoBom)
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    }
}

function Read-EnglishStudyRuntimeFileSnapshot {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return [pscustomobject]@{ exists=$false; raw=$null } }
    try { return [pscustomobject]@{ exists=$true; raw=[IO.File]::ReadAllText($Path) } }
    catch { return [pscustomobject]@{ exists=$true; raw=$null } }
}

function Remove-EnglishStudyRuntimeFileSnapshot {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)]$Snapshot)
    if (-not [bool]$Snapshot.exists) { return $true }
    if ($null -eq $Snapshot.raw) { return $false }
    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $true }
        if ([IO.File]::ReadAllText($Path) -cne [string]$Snapshot.raw) { return $false }
        Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
        return $true
    }
    catch { return $false }
}

function Remove-EnglishStudyOwnershipPair {
    param($Definition, $PidSnapshot, $OwnerSnapshot)
    foreach ($entry in @(@{ path=$Definition.pidFile; snapshot=$PidSnapshot }, @{ path=$Definition.ownerFile; snapshot=$OwnerSnapshot })) {
        if ([bool]$entry.snapshot.exists) {
            if ($null -eq $entry.snapshot.raw -or -not (Test-Path -LiteralPath $entry.path -PathType Leaf) -or [IO.File]::ReadAllText($entry.path) -cne [string]$entry.snapshot.raw) { return $false }
        }
        elseif (Test-Path -LiteralPath $entry.path -PathType Leaf) { return $false }
    }
    if (-not (Remove-EnglishStudyRuntimeFileSnapshot -Path $Definition.ownerFile -Snapshot $OwnerSnapshot)) { return $false }
    return (Remove-EnglishStudyRuntimeFileSnapshot -Path $Definition.pidFile -Snapshot $PidSnapshot)
}

function Get-EnglishStudyListenerState {
    param([int]$Port)
    $netstatPath = Join-Path $env:WINDIR "System32\netstat.exe"
    if (-not (Test-Path -LiteralPath $netstatPath -PathType Leaf)) {
        return [pscustomobject]@{ known=$false; pids=@(); errorCode="listener_query_unavailable" }
    }
    try {
        $listenerPids = @()
        $lines = @(& $netstatPath -ano -p TCP 2>$null)
        if ($LASTEXITCODE -ne 0) { throw "netstat failed" }
        foreach ($line in $lines) {
            if ([string]$line -match ("^\s*TCP\s+\S+:" + $Port + "\s+\S+\s+LISTENING\s+(\d+)\s*$")) { $listenerPids += [int]$Matches[1] }
        }
        return [pscustomobject]@{ known=$true; pids=@($listenerPids | Sort-Object -Unique); errorCode=$null }
    }
    catch { return [pscustomobject]@{ known=$false; pids=@(); errorCode="listener_query_failed" } }
}

function Get-EnglishStudyProcessInspection {
    param([int]$ProcessId)
    try { $nativeProcess = Get-Process -Id $ProcessId -ErrorAction Stop }
    catch {
        $missing = $_.CategoryInfo.Category -eq [Management.Automation.ErrorCategory]::ObjectNotFound
        return [pscustomobject]@{ state=$(if ($missing) { "MissingConfirmed" } else { "Unknown" }); process=$null }
    }
    $path = $null; $startedUtc = $null; $cim = $null
    try { $path = [string]$nativeProcess.Path } catch { }
    try { $startedUtc = $nativeProcess.StartTime.ToUniversalTime().ToString("o") } catch { }
    try { $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop } catch { }
    if ([string]::IsNullOrWhiteSpace($path) -and $null -ne $cim) { $path = [string]$cim.ExecutablePath }
    return [pscustomobject]@{
        state="Present"
        process=[pscustomobject]@{
            ProcessId=[int]$nativeProcess.Id
            ParentProcessId=$(if ($null -eq $cim) { $null } else { [int]$cim.ParentProcessId })
            ExecutablePath=$path
            StartTimeUtc=$startedUtc
            CommandLine=$(if ($null -eq $cim) { $null } else { [string]$cim.CommandLine })
        }
    }
}

function Get-EnglishStudyTerminationBinding {
    param([Parameter(Mandatory = $true)]$ExpectedProcess)
    $nativeProcess = $null
    try {
        $nativeProcess = Get-Process -Id ([int]$ExpectedProcess.ProcessId) -ErrorAction Stop
        $null = $nativeProcess.Handle
        if ($nativeProcess.HasExited) {
            $nativeProcess.Dispose()
            return [pscustomobject]@{ state="MissingConfirmed"; process=$null; nativeProcess=$null }
        }
        $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$ExpectedProcess.ProcessId)" -ErrorAction Stop
        $process = [pscustomobject]@{
            ProcessId=[int]$nativeProcess.Id; ParentProcessId=[int]$cim.ParentProcessId
            ExecutablePath=[string]$nativeProcess.Path; StartTimeUtc=$nativeProcess.StartTime.ToUniversalTime().ToString("o")
            CommandLine=[string]$cim.CommandLine
        }
        $matches = (
            [int]$process.ProcessId -eq [int]$ExpectedProcess.ProcessId -and
            [int]$process.ParentProcessId -eq [int]$ExpectedProcess.ParentProcessId -and
            (Test-EnglishStudyPathEqual $process.ExecutablePath $ExpectedProcess.ExecutablePath) -and
            -not [string]::IsNullOrWhiteSpace([string]$process.StartTimeUtc) -and
            [string]$process.StartTimeUtc -eq [string]$ExpectedProcess.StartTimeUtc
        )
        if (-not $matches) {
            $nativeProcess.Dispose()
            return [pscustomobject]@{ state="OwnershipChanged"; process=$process; nativeProcess=$null }
        }
        return [pscustomobject]@{ state="Present"; process=$process; nativeProcess=$nativeProcess }
    }
    catch {
        if ($null -ne $nativeProcess) { try { $nativeProcess.Dispose() } catch { } }
        $missing = $_.CategoryInfo.Category -eq [Management.Automation.ErrorCategory]::ObjectNotFound
        return [pscustomobject]@{ state=$(if ($missing) { "MissingConfirmed" } else { "Unknown" }); process=$null; nativeProcess=$null }
    }
}

function Get-EnglishStudyRoleDefinition {
    param($Context, [ValidateSet("hub", "mcp", "tunnel")][string]$Role)
    switch ($Role) {
        "hub" { return [pscustomobject]@{ pidFile=$Context.hubPidFile; ownerFile=$Context.hubOwnerFile; port=$Context.hubPort; executablePath=$Context.pythonPath; identity=$Context.hubIdentity } }
        "mcp" { return [pscustomobject]@{ pidFile=$Context.mcpPidFile; ownerFile=$Context.mcpOwnerFile; port=$Context.mcpPort; executablePath=$Context.nodePath; identity=$Context.mcpIdentity } }
        default { return [pscustomobject]@{ pidFile=$Context.tunnelPidFile; ownerFile=$Context.tunnelOwnerFile; port=$Context.tunnelHealthPort; executablePath=$Context.tunnelClientPath; identity=$Context.tunnelIdentity } }
    }
}

function Test-EnglishStudyPathEqual {
    param([string]$Left, [string]$Right)
    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { return $false }
    try { return [IO.Path]::GetFullPath($Left).TrimEnd('\').Equals([IO.Path]::GetFullPath($Right).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) }
    catch { return $false }
}

function Test-EnglishStudyCommandIdentity {
    param([string]$CommandLine, [string]$Identity)
    if ([string]::IsNullOrWhiteSpace($CommandLine) -or [string]::IsNullOrWhiteSpace($Identity)) { return $false }
    foreach ($fragment in @($Identity -split '\s+')) {
        if ($CommandLine.IndexOf($fragment, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
    }
    return $true
}

function Read-EnglishStudyOwnerMetadata {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) | ConvertFrom-Json }
    catch { return $null }
}

function Test-EnglishStudyOwnerMetadata {
    param($Context, [ValidateSet("hub", "mcp", "tunnel")][string]$Role, $Process, $Metadata)
    if ($null -eq $Process -or $null -eq $Metadata) { return $false }
    foreach ($name in @("schemaVersion","role","pid","executablePath","startTimeUtc","identity")) {
        if ($null -eq $Metadata.PSObject.Properties[$name]) { return $false }
    }
    $definition = Get-EnglishStudyRoleDefinition -Context $Context -Role $Role
    return (
        [int]$Metadata.schemaVersion -eq 1 -and [string]$Metadata.role -eq $Role -and
        [int]$Metadata.pid -eq [int]$Process.ProcessId -and
        (Test-EnglishStudyPathEqual ([string]$Metadata.executablePath) $definition.executablePath) -and
        (Test-EnglishStudyPathEqual $Process.ExecutablePath $definition.executablePath) -and
        -not [string]::IsNullOrWhiteSpace([string]$Process.StartTimeUtc) -and
        [string]$Metadata.startTimeUtc -eq [string]$Process.StartTimeUtc -and
        [string]$Metadata.identity -eq [string]$definition.identity -and
        ([string]::IsNullOrWhiteSpace([string]$Process.CommandLine) -or (Test-EnglishStudyCommandIdentity $Process.CommandLine $definition.identity))
    )
}

function Write-EnglishStudyOwnerMetadata {
    param($Context, [ValidateSet("hub", "mcp", "tunnel")][string]$Role, $Process)
    $definition = Get-EnglishStudyRoleDefinition -Context $Context -Role $Role
    $metadata = [ordered]@{
        schemaVersion=1; role=$Role; pid=[int]$Process.ProcessId
        executablePath=[string]$Process.ExecutablePath; startTimeUtc=[string]$Process.StartTimeUtc
        identity=[string]$definition.identity; recordedAt=[DateTime]::UtcNow.ToString("o")
    }
    Write-EnglishStudyAtomicText -Path $definition.pidFile -Value ([string]$Process.ProcessId)
    Write-EnglishStudyAtomicText -Path $definition.ownerFile -Value ($metadata | ConvertTo-Json -Compress)
}

function Get-EnglishStudyLineage {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][int]$ExpectedAncestorProcessId
    )
    if ($ProcessId -eq $ExpectedAncestorProcessId) {
        return [pscustomobject]@{ known=$true; matches=$true; depth=0 }
    }
    $current = $ProcessId
    for ($depth = 0; $depth -lt 32; $depth++) {
        try { $process = Get-CimInstance Win32_Process -Filter "ProcessId = $current" -ErrorAction Stop }
        catch { return [pscustomobject]@{ known=$false; matches=$false; depth=$null } }
        $parent = [int]$process.ParentProcessId
        if ($parent -eq $ExpectedAncestorProcessId) {
            return [pscustomobject]@{ known=$true; matches=$true; depth=($depth + 1) }
        }
        if ($parent -le 0 -or $parent -eq $current) {
            return [pscustomobject]@{ known=$true; matches=$false; depth=$null }
        }
        $current = $parent
    }
    return [pscustomobject]@{ known=$false; matches=$false; depth=$null }
}

function Get-EnglishStudyOwnedDescendants {
    param([Parameter(Mandatory = $true)][int]$RootPid)
    $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $byPid = @{}
    foreach ($process in $all) { $byPid[[int]$process.ProcessId] = $process }
    $candidates = @()
    foreach ($process in $all) {
        $current = [int]$process.ProcessId
        for ($depth = 0; $depth -lt 32; $depth++) {
            if ($current -eq $RootPid) {
                $candidates += [pscustomobject]@{ ProcessId=[int]$process.ProcessId; Depth=$depth }
                break
            }
            if (-not $byPid.ContainsKey($current)) { break }
            $parent = [int]$byPid[$current].ParentProcessId
            if ($parent -le 0 -or $parent -eq $current) { break }
            $current = $parent
        }
    }
    $rows = @()
    foreach ($candidate in $candidates) {
        $inspection = Get-EnglishStudyProcessInspection -ProcessId ([int]$candidate.ProcessId)
        if ($inspection.state -eq "MissingConfirmed") { continue }
        if ($inspection.state -ne "Present" -or $null -eq $inspection.process -or
            $null -eq $inspection.process.ParentProcessId -or
            [string]::IsNullOrWhiteSpace([string]$inspection.process.ExecutablePath) -or
            [string]::IsNullOrWhiteSpace([string]$inspection.process.StartTimeUtc)) {
            throw "OWNERSHIP_UNKNOWN: Descendant process identity is unavailable."
        }
        $rows += [pscustomobject]@{
            ProcessId=[int]$inspection.process.ProcessId; ParentProcessId=[int]$inspection.process.ParentProcessId
            ExecutablePath=[string]$inspection.process.ExecutablePath; StartTimeUtc=[string]$inspection.process.StartTimeUtc
            Depth=[int]$candidate.Depth
        }
    }
    return @($rows | Sort-Object -Property @{ Expression='Depth'; Descending=$true }, @{ Expression='ProcessId'; Descending=$true })
}

function Invoke-EnglishStudyChildProcess {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Start,
        [hashtable]$Environment = @{}
    )
    $overrides = @{}
    foreach ($name in @("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")) { $overrides[$name] = $null }
    $overrides["NO_PROXY"] = "127.0.0.1,localhost"
    $overrides["no_proxy"] = "127.0.0.1,localhost"
    foreach ($name in $Environment.Keys) { $overrides[[string]$name] = $Environment[$name] }
    $saved = @{}
    try {
        foreach ($name in $overrides.Keys) {
            $saved[$name] = [Environment]::GetEnvironmentVariable([string]$name, "Process")
            [Environment]::SetEnvironmentVariable([string]$name, $overrides[$name], "Process")
        }
        return (& $Start)
    }
    finally {
        foreach ($name in $overrides.Keys) { [Environment]::SetEnvironmentVariable([string]$name, $saved[$name], "Process") }
    }
}

function Get-EnglishStudyRoleState {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][ValidateSet("hub", "mcp", "tunnel")][string]$Role
    )
    $definition = Get-EnglishStudyRoleDefinition -Context $Context -Role $Role
    $pidSnapshot = Read-EnglishStudyRuntimeFileSnapshot -Path $definition.pidFile
    $ownerSnapshot = Read-EnglishStudyRuntimeFileSnapshot -Path $definition.ownerFile
    $managedPid = Read-EnglishStudyPid -Path $definition.pidFile
    $metadata = Read-EnglishStudyOwnerMetadata -Path $definition.ownerFile
    $managedInspection = if ($null -eq $managedPid) { $null } else { Get-EnglishStudyProcessInspection -ProcessId $managedPid }
    $listener = Get-EnglishStudyListenerState -Port $definition.port
    if (-not $listener.known) {
        return [pscustomobject]@{ role=$Role; state="OwnershipUnknown"; canMutate=$false; managedPid=$managedPid; listenerPid=$null; relation="Unknown"; reason=$listener.errorCode }
    }
    if ($listener.pids.Count -gt 1) {
        return [pscustomobject]@{ role=$Role; state="OwnershipMismatch"; canMutate=$false; managedPid=$managedPid; listenerPid=$null; relation="Multiple"; reason="multiple_listener_owners" }
    }
    $listenerPid = if ($listener.pids.Count -eq 1) { [int]$listener.pids[0] } else { $null }
    $listenerInspection = if ($null -eq $listenerPid) { $null } else { Get-EnglishStudyProcessInspection -ProcessId $listenerPid }
    if ($null -ne $listenerInspection -and $listenerInspection.state -ne "Present") {
        return [pscustomobject]@{ role=$Role; state="OwnershipUnknown"; canMutate=$false; managedPid=$managedPid; listenerPid=$listenerPid; relation="Unknown"; reason="listener_process_inspection_failed" }
    }
    $listenerProcess = if ($null -eq $listenerInspection) { $null } else { $listenerInspection.process }

    if ($pidSnapshot.exists -and $null -eq $managedPid) {
        if ($null -ne $listenerPid) { return [pscustomobject]@{ role=$Role; state="OwnershipMismatch"; canMutate=$false; managedPid=$null; listenerPid=$listenerPid; relation="Unknown"; reason="invalid_pid_file_with_listener" } }
        if (-not (Remove-EnglishStudyOwnershipPair -Definition $definition -PidSnapshot $pidSnapshot -OwnerSnapshot $ownerSnapshot)) {
            return [pscustomobject]@{ role=$Role; state="OwnershipUnknown"; canMutate=$false; managedPid=$null; listenerPid=$null; relation="Unknown"; reason="stale_metadata_changed_during_cleanup" }
        }
    }
    if ($null -ne $managedPid) {
        if ($managedInspection.state -eq "Unknown") { return [pscustomobject]@{ role=$Role; state="OwnershipUnknown"; canMutate=$false; managedPid=$managedPid; listenerPid=$listenerPid; relation="Unknown"; reason="managed_process_inspection_failed" } }
        if ($managedInspection.state -eq "MissingConfirmed") {
            if ($null -ne $listenerPid) { return [pscustomobject]@{ role=$Role; state="OwnershipMismatch"; canMutate=$false; managedPid=$managedPid; listenerPid=$listenerPid; relation="Unknown"; reason="stale_pid_with_listener" } }
            if (-not (Remove-EnglishStudyOwnershipPair -Definition $definition -PidSnapshot $pidSnapshot -OwnerSnapshot $ownerSnapshot)) {
                return [pscustomobject]@{ role=$Role; state="OwnershipUnknown"; canMutate=$false; managedPid=$managedPid; listenerPid=$null; relation="Unknown"; reason="stale_metadata_changed_during_cleanup" }
            }
            $managedPid = $null
        }
    }
    $managedProcess = if ($null -eq $managedPid) { $null } else { $managedInspection.process }
    if ($null -ne $managedProcess) {
        if ([string]::IsNullOrWhiteSpace([string]$managedProcess.ExecutablePath) -or [string]::IsNullOrWhiteSpace([string]$managedProcess.StartTimeUtc)) {
            return [pscustomobject]@{ role=$Role; state="OwnershipUnknown"; canMutate=$false; managedPid=$managedPid; listenerPid=$listenerPid; relation="Unknown"; reason="managed_process_identity_incomplete" }
        }
        $pathMatches = Test-EnglishStudyPathEqual $managedProcess.ExecutablePath $definition.executablePath
        $commandKnown = -not [string]::IsNullOrWhiteSpace([string]$managedProcess.CommandLine)
        $commandMatches = $commandKnown -and (Test-EnglishStudyCommandIdentity $managedProcess.CommandLine $definition.identity)
        $metadataComplete = Test-EnglishStudyOwnerMetadata -Context $Context -Role $Role -Process $managedProcess -Metadata $metadata
        $metadataHasInstance = $null -ne $metadata -and $null -ne $metadata.PSObject.Properties["pid"] -and $null -ne $metadata.PSObject.Properties["executablePath"] -and $null -ne $metadata.PSObject.Properties["startTimeUtc"] -and [int]$metadata.pid -eq $managedPid
        $positiveMismatch = -not $pathMatches -or ($commandKnown -and -not $commandMatches) -or ($metadataHasInstance -and (
            -not (Test-EnglishStudyPathEqual ([string]$metadata.executablePath) ([string]$managedProcess.ExecutablePath)) -or
            [string]$metadata.startTimeUtc -ne [string]$managedProcess.StartTimeUtc
        ))
        if ($positiveMismatch) {
            if ($null -ne $listenerPid) { return [pscustomobject]@{ role=$Role; state="OwnershipMismatch"; canMutate=$false; managedPid=$managedPid; listenerPid=$listenerPid; relation="Unknown"; reason="pid_process_mismatch" } }
            if (-not (Remove-EnglishStudyOwnershipPair -Definition $definition -PidSnapshot $pidSnapshot -OwnerSnapshot $ownerSnapshot)) {
                return [pscustomobject]@{ role=$Role; state="OwnershipUnknown"; canMutate=$false; managedPid=$managedPid; listenerPid=$null; relation="Unknown"; reason="stale_metadata_changed_during_cleanup" }
            }
            $managedPid = $null; $managedProcess = $null
        }
        elseif (-not $metadataComplete) {
            return [pscustomobject]@{ role=$Role; state="OwnershipUnknown"; canMutate=$false; managedPid=$managedPid; listenerPid=$listenerPid; relation="Unknown"; reason="owner_metadata_unavailable_or_incoherent" }
        }
    }
    if ($null -eq $listenerProcess -and $null -eq $managedProcess) {
        return [pscustomobject]@{ role=$Role; state="Stopped"; canMutate=$true; managedPid=$null; listenerPid=$null; relation=$null; reason=$null }
    }
    if ($null -ne $managedProcess -and (Test-EnglishStudyOwnerMetadata -Context $Context -Role $Role -Process $managedProcess -Metadata $metadata)) {
        if ($null -eq $listenerProcess) { return [pscustomobject]@{ role=$Role; state="Starting"; canMutate=$true; managedPid=[int]$managedProcess.ProcessId; listenerPid=$null; relation=$null; reason=$null } }
        $lineage = Get-EnglishStudyLineage -ProcessId ([int]$listenerProcess.ProcessId) -ExpectedAncestorProcessId ([int]$managedProcess.ProcessId)
        if (-not $lineage.known) { return [pscustomobject]@{ role=$Role; state="OwnershipUnknown"; canMutate=$false; managedPid=[int]$managedProcess.ProcessId; listenerPid=[int]$listenerProcess.ProcessId; relation="Unknown"; reason="listener_lineage_unavailable" } }
        if ($lineage.matches) { return [pscustomobject]@{ role=$Role; state="Owned"; canMutate=$true; managedPid=[int]$managedProcess.ProcessId; listenerPid=[int]$listenerProcess.ProcessId; relation=$(if ([int]$lineage.depth -eq 0) { "Self" } else { "Descendant" }); reason=$null } }
        return [pscustomobject]@{ role=$Role; state="OwnershipMismatch"; canMutate=$false; managedPid=[int]$managedProcess.ProcessId; listenerPid=[int]$listenerProcess.ProcessId; relation="Unrelated"; reason="listener_lineage_mismatch" }
    }
    return [pscustomobject]@{ role=$Role; state="OwnershipMismatch"; canMutate=$false; managedPid=$(if ($null -eq $managedProcess) { $null } else { [int]$managedProcess.ProcessId }); listenerPid=$(if ($null -eq $listenerProcess) { $null } else { [int]$listenerProcess.ProcessId }); relation="Unknown"; reason="listener_without_owned_root" }
}

function Test-EnglishStudyHealth {
    param([string]$Url, [string]$ExpectedService)
    try {
        $response = Invoke-RestMethod -Uri $Url -TimeoutSec 2 -ErrorAction Stop
        return $response.ok -eq $true -and [string]$response.service -eq $ExpectedService
    }
    catch { return $false }
}

function Test-EnglishStudyTunnelReady {
    param([Parameter(Mandatory = $true)]$Context)
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "$($Context.tunnelHealthUrl)/readyz" -TimeoutSec 2 -ErrorAction Stop
        $content = if ($response.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($response.Content) } else { [string]$response.Content }
        return ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300 -and $content.Trim() -in @("ready", "ok"))
    }
    catch { return $false }
}

function Get-EnglishStudyRuntimeStatus {
    param([Parameter(Mandatory = $true)]$Context)
    $hub = Get-EnglishStudyRoleState -Context $Context -Role hub
    $mcp = Get-EnglishStudyRoleState -Context $Context -Role mcp
    $tunnel = Get-EnglishStudyRoleState -Context $Context -Role tunnel
    $hubHealthy = Test-EnglishStudyHealth -Url $Context.hubHealth -ExpectedService "english-study-hub"
    $mcpHealthy = Test-EnglishStudyHealth -Url $Context.mcpHealth -ExpectedService "english-study-mcp"
    $tunnelReady = Test-EnglishStudyTunnelReady -Context $Context
    $states = @($hub.state, $mcp.state, $tunnel.state)
    $status = if ($states -contains "OwnershipUnknown") { "OwnershipUnknown" }
        elseif ($states -contains "OwnershipMismatch") { "OwnershipMismatch" }
        elseif ($hub.state -eq "Stopped" -and $mcp.state -eq "Stopped" -and $tunnel.state -eq "Stopped") { "Stopped" }
        elseif ($hub.state -eq "Owned" -and $mcp.state -eq "Owned" -and $tunnel.state -eq "Owned" -and $hubHealthy -and $mcpHealthy -and $tunnelReady) { "Ready" }
        elseif ($hub.state -eq "Owned" -and $mcp.state -eq "Owned" -and $hubHealthy -and $mcpHealthy) { "Degraded" }
        else { "Unhealthy" }
    [pscustomobject]@{
        status = $status
        hub = [pscustomobject]@{ healthy=$hubHealthy; ownership=$hub.state; pid=$hub.managedPid; listenerPid=$hub.listenerPid; relation=$hub.relation }
        mcp = [pscustomobject]@{ healthy=$mcpHealthy; ownership=$mcp.state; pid=$mcp.managedPid; listenerPid=$mcp.listenerPid; relation=$mcp.relation }
        tunnel = [pscustomobject]@{ ready=$tunnelReady; ownership=$tunnel.state; pid=$tunnel.managedPid; listenerPid=$tunnel.listenerPid; relation=$tunnel.relation }
        ownedPids = @(@($hub, $mcp, $tunnel) | Where-Object { $_.state -eq "Owned" } | ForEach-Object { $_.managedPid })
    }
}

function Assert-EnglishStudySourceReady {
    param([Parameter(Mandatory = $true)]$Context)
    foreach ($path in @($Context.pythonPath, (Join-Path $Context.hubRoot "pyproject.toml"), $Context.nodePath, $Context.mcpEntry)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "SOURCE_NOT_READY: Required runtime file is missing." }
    }
    $newestSource = Get-ChildItem -LiteralPath (Join-Path $Context.projectRoot "src") -Filter "*.ts" -File -Recurse | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    $artifact = Get-Item -LiteralPath $Context.mcpEntry
    if ($null -ne $newestSource -and $newestSource.LastWriteTimeUtc -gt $artifact.LastWriteTimeUtc) {
        throw "BUILD_STALE: English Study TypeScript source is newer than dist; run npm run build."
    }
}

function Start-EnglishStudyRole {
    param([Parameter(Mandatory = $true)]$Context, [Parameter(Mandatory = $true)][ValidateSet("hub", "mcp", "tunnel")][string]$Role)
    New-Item -ItemType Directory -Force -Path $Context.runtimeDir | Out-Null
    if ($Role -eq "hub") {
        $process = Invoke-EnglishStudyChildProcess -Environment @{ PYTHONUTF8 = "1" } -Start {
            Start-Process -FilePath $Context.pythonPath -WorkingDirectory $Context.hubRoot -ArgumentList @($Context.hubArguments) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Context.runtimeDir "hub.stdout.log") -RedirectStandardError (Join-Path $Context.runtimeDir "hub.stderr.log") -PassThru
        }
    }
    elseif ($Role -eq "mcp") {
        $process = Invoke-EnglishStudyChildProcess -Environment @{
            ESTUDY_HUB_BASE_URL = "http://$($Context.hostName):$($Context.hubPort)"
            ESTUDY_MCP_HOST = $Context.hostName
            ESTUDY_MCP_PORT = [string]$Context.mcpPort
        } -Start {
            Start-Process -FilePath $Context.nodePath -WorkingDirectory $Context.projectRoot -ArgumentList @($Context.mcpEntry) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Context.runtimeDir "mcp.stdout.log") -RedirectStandardError (Join-Path $Context.runtimeDir "mcp.stderr.log") -PassThru
        }
    }
    else {
        if (-not (Test-EnglishStudyHealth -Url $Context.mcpHealth -ExpectedService "english-study-mcp")) { throw "MCP_NOT_READY: Tunnel start requires the MCP adapter." }
        foreach ($required in @($Context.tunnelClientPath, $Context.tunnelProfilePath, $Context.keyStorePath)) {
            if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "TUNNEL_CONFIG_MISSING: Tunnel runtime is incomplete." }
        }
        . $Context.keyStorePath
        $savedKey = [Environment]::GetEnvironmentVariable("CONTROL_PLANE_API_KEY", "Process")
        [Environment]::SetEnvironmentVariable("CONTROL_PLANE_API_KEY", $null, "Process")
        try {
            if (-not (Set-ControlPlaneApiKeyEnvFromSecret -ProjectRoot $Context.projectRoot -SecretPath $Context.secretPath)) { throw "TUNNEL_KEY_MISSING: Tunnel runtime key is unavailable." }
            $decryptedKey = $env:CONTROL_PLANE_API_KEY
            $process = Invoke-EnglishStudyChildProcess -Environment @{ CONTROL_PLANE_API_KEY = $decryptedKey } -Start {
                Start-Process -FilePath $Context.tunnelClientPath -WorkingDirectory $Context.projectRoot -ArgumentList $Context.tunnelArguments -WindowStyle Hidden -PassThru
            }
        }
        finally {
            $decryptedKey = $null
            [Environment]::SetEnvironmentVariable("CONTROL_PLANE_API_KEY", $savedKey, "Process")
        }
        if ($null -eq $process) { throw "TUNNEL_START_FAILED: Tunnel process did not start." }
    }
    if ($null -eq $process) { throw "START_FAILED: $Role process did not start." }
    $startedInspection = Get-EnglishStudyProcessInspection -ProcessId $process.Id
    if ($startedInspection.state -ne "Present" -or $null -eq $startedInspection.process) { throw "START_FAILED: Started $Role process is unavailable." }
    Write-EnglishStudyOwnerMetadata -Context $Context -Role $Role -Process $startedInspection.process
}

function Wait-EnglishStudyReady {
    param([Parameter(Mandatory = $true)]$Context)
    $deadline = [DateTime]::UtcNow.AddSeconds($Context.readyTimeoutSeconds)
    do {
        $status = Get-EnglishStudyRuntimeStatus -Context $Context
        if ($status.status -eq "Ready") { return }
        if ($status.status -in @("OwnershipMismatch", "OwnershipUnknown")) { throw "OWNERSHIP_MISMATCH: A required runtime ownership state is not safe to mutate." }
        Start-Sleep -Milliseconds 300
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "READINESS_TIMEOUT: English Study did not become Ready within the bounded timeout."
}

function Stop-EnglishStudyRole {
    param([Parameter(Mandatory = $true)]$Context, [Parameter(Mandatory = $true)][ValidateSet("hub", "mcp", "tunnel")][string]$Role)
    $definition = Get-EnglishStudyRoleDefinition -Context $Context -Role $Role
    $pidSnapshot = Read-EnglishStudyRuntimeFileSnapshot -Path $definition.pidFile
    $ownerSnapshot = Read-EnglishStudyRuntimeFileSnapshot -Path $definition.ownerFile
    $state = Get-EnglishStudyRoleState -Context $Context -Role $Role
    if (-not $state.canMutate) { throw "OWNERSHIP_MISMATCH: Refusing to stop $Role while ownership is $($state.state)." }
    if ($state.state -eq "Stopped") { return }
    if ($null -ne $state.managedPid) {
        $rootPid = [int]$state.managedPid
        $snapshots = @(Get-EnglishStudyOwnedDescendants -RootPid $rootPid)
        $snapshotByPid = @{}; foreach ($entry in $snapshots) { $snapshotByPid[[int]$entry.ProcessId] = $entry }
        if (-not $snapshotByPid.ContainsKey($rootPid)) { throw "OWNERSHIP_CHANGED: Managed root disappeared before stop." }
        try { $ownerMetadata = [string]$ownerSnapshot.raw | ConvertFrom-Json }
        catch { throw "OWNERSHIP_UNKNOWN: Owner metadata became unavailable before stop." }
        $bindings = @(); $bindingByPid = @{}
        try {
            foreach ($entry in @($snapshots | Sort-Object Depth, ProcessId)) {
                if ([int]$entry.ProcessId -eq $PID) { throw "OWNERSHIP_MISMATCH: Refusing to stop the lifecycle controller." }
                $binding = Get-EnglishStudyTerminationBinding -ExpectedProcess $entry
                if ($binding.state -eq "MissingConfirmed") { continue }
                if ($binding.state -ne "Present") { throw "OWNERSHIP_CHANGED: PID $($entry.ProcessId) changed before stop." }
                $bindings += [pscustomobject]@{ snapshot=$entry; nativeProcess=$binding.nativeProcess; process=$binding.process }
                $bindingByPid[[int]$entry.ProcessId] = $bindings[-1]
            }
            if (-not $bindingByPid.ContainsKey($rootPid) -or
                -not (Test-EnglishStudyOwnerMetadata -Context $Context -Role $Role -Process $bindingByPid[$rootPid].process -Metadata $ownerMetadata)) {
                throw "OWNERSHIP_CHANGED: Managed root identity changed before stop."
            }
            if ([IO.File]::ReadAllText($definition.ownerFile) -cne [string]$ownerSnapshot.raw) { throw "OWNERSHIP_CHANGED: Owner metadata changed before stop." }
            foreach ($binding in $bindings) {
                $currentPid = [int]$binding.snapshot.ProcessId
                if ($currentPid -eq $rootPid) { continue }
                for ($depth = 0; $depth -lt 32 -and $currentPid -ne $rootPid; $depth++) {
                    if (-not $snapshotByPid.ContainsKey($currentPid) -or -not $bindingByPid.ContainsKey($currentPid)) { throw "OWNERSHIP_CHANGED: Descendant lineage changed before stop." }
                    $currentPid = [int]$snapshotByPid[$currentPid].ParentProcessId
                }
                if ($currentPid -ne $rootPid) { throw "OWNERSHIP_CHANGED: Descendant no longer belongs to the verified root." }
            }
            foreach ($binding in @($bindings | Sort-Object @{ Expression={ [int]$_.snapshot.Depth }; Descending=$true }, @{ Expression={ [int]$_.snapshot.ProcessId }; Descending=$true })) {
                if (-not $binding.nativeProcess.HasExited) { $binding.nativeProcess.Kill() }
                if (-not $binding.nativeProcess.WaitForExit(5000)) { throw "STOP_FAILED: PID $($binding.snapshot.ProcessId) did not exit." }
            }
        }
        finally {
            foreach ($binding in $bindings) { if ($null -ne $binding.nativeProcess) { $binding.nativeProcess.Dispose() } }
        }
    }
    if (-not (Remove-EnglishStudyOwnershipPair -Definition $definition -PidSnapshot $pidSnapshot -OwnerSnapshot $ownerSnapshot)) {
        throw "OWNERSHIP_CHANGED: Runtime metadata changed before cleanup."
    }
}

function Wait-EnglishStudyCoreReady {
    param([Parameter(Mandatory = $true)]$Context)
    $deadline = [DateTime]::UtcNow.AddSeconds($Context.readyTimeoutSeconds)
    do {
        $hubReady = Test-EnglishStudyHealth -Url $Context.hubHealth -ExpectedService "english-study-hub"
        $mcpReady = Test-EnglishStudyHealth -Url $Context.mcpHealth -ExpectedService "english-study-mcp"
        $hub = Get-EnglishStudyRoleState -Context $Context -Role hub
        $mcp = Get-EnglishStudyRoleState -Context $Context -Role mcp
        if (-not $hub.canMutate -or -not $mcp.canMutate) { throw "OWNERSHIP_MISMATCH: A core runtime ownership state is not safe to mutate." }
        if ($hubReady -and $mcpReady -and $hub.state -eq "Owned" -and $mcp.state -eq "Owned") { return }
        Start-Sleep -Milliseconds 300
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "CORE_READINESS_TIMEOUT: English Study core did not become ready."
}

function Repair-EnglishStudyConnectivity {
    param([Parameter(Mandatory = $true)]$Context)
    Wait-EnglishStudyCoreReady -Context $Context
    $tunnel = Get-EnglishStudyRoleState -Context $Context -Role tunnel
    if (-not $tunnel.canMutate) { throw "OWNERSHIP_MISMATCH: Cannot repair tunnel while ownership is $($tunnel.state)." }
    if ($tunnel.state -eq "Owned" -and (Test-EnglishStudyTunnelReady -Context $Context)) { return }
    if ($tunnel.state -ne "Stopped") { Stop-EnglishStudyRole -Context $Context -Role tunnel }
    $lastTunnelState = $tunnel.state
    foreach ($delay in @($Context.tunnelRecoveryDelaysSeconds)) {
        Start-EnglishStudyRole -Context $Context -Role tunnel
        $deadline = [DateTime]::UtcNow.AddSeconds([int]$delay)
        do {
            $state = Get-EnglishStudyRoleState -Context $Context -Role tunnel
            $lastTunnelState = $state.state
            if (Test-EnglishStudyTunnelReady -Context $Context) {
                if ($state.state -eq "Owned") { return }
                throw "OWNERSHIP_MISMATCH: Tunnel listener is not owned by the started process."
            }
            Start-Sleep -Milliseconds 300
        } while ([DateTime]::UtcNow -lt $deadline)
        Stop-EnglishStudyRole -Context $Context -Role tunnel
    }
    throw "TUNNEL_NOT_READY: Tunnel failed bounded recovery; final ownership state was $lastTunnelState."
}

function Assert-EnglishStudyMutationPreflight {
    param([Parameter(Mandatory = $true)]$Context, [Parameter(Mandatory = $true)][string[]]$Roles)
    foreach ($role in $Roles) {
        $state = Get-EnglishStudyRoleState -Context $Context -Role $role
        if (-not $state.canMutate) { throw "OWNERSHIP_MISMATCH: Cannot mutate $role while ownership is $($state.state)." }
    }
}

function Invoke-EnglishStudyLifecycleAction {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][ValidateSet("EnsureRunning", "RepairConnectivity", "RestartCore", "ReloadRuntime", "ShutdownRuntime")][string]$Action
    )
    if ($Action -eq "ShutdownRuntime") {
        Assert-EnglishStudyMutationPreflight -Context $Context -Roles @("hub", "mcp", "tunnel")
        Stop-EnglishStudyRole -Context $Context -Role tunnel
        Stop-EnglishStudyRole -Context $Context -Role mcp
        Stop-EnglishStudyRole -Context $Context -Role hub
        return
    }
    Assert-EnglishStudySourceReady -Context $Context
    $status = Get-EnglishStudyRuntimeStatus -Context $Context
    if ($status.status -in @("OwnershipMismatch", "OwnershipUnknown")) { throw "OWNERSHIP_MISMATCH: Refusing lifecycle changes while ownership is not safely established." }
    if ($Action -eq "RepairConnectivity") { Repair-EnglishStudyConnectivity -Context $Context; return }
    if ($Action -in @("RestartCore", "ReloadRuntime")) {
        $roles = if ($Action -eq "ReloadRuntime") { @("hub", "mcp", "tunnel") } else { @("hub", "mcp") }
        Assert-EnglishStudyMutationPreflight -Context $Context -Roles $roles
        if ($Action -eq "ReloadRuntime") { Stop-EnglishStudyRole -Context $Context -Role tunnel }
        Stop-EnglishStudyRole -Context $Context -Role mcp
        Stop-EnglishStudyRole -Context $Context -Role hub
        $status = Get-EnglishStudyRuntimeStatus -Context $Context
    }
    if ($status.hub.ownership -ne "Owned") { Start-EnglishStudyRole -Context $Context -Role hub }
    $deadline = [DateTime]::UtcNow.AddSeconds($Context.readyTimeoutSeconds)
    while (-not (Test-EnglishStudyHealth -Url $Context.hubHealth -ExpectedService "english-study-hub")) {
        if ([DateTime]::UtcNow -ge $deadline) { throw "HUB_READINESS_TIMEOUT: English Study Hub did not become ready." }
        Start-Sleep -Milliseconds 300
    }
    $mcpState = Get-EnglishStudyRoleState -Context $Context -Role mcp
    if ($mcpState.state -ne "Owned") { Start-EnglishStudyRole -Context $Context -Role mcp }
    Wait-EnglishStudyCoreReady -Context $Context
    if ($Action -eq "RestartCore") { return }
    Repair-EnglishStudyConnectivity -Context $Context
    Wait-EnglishStudyReady -Context $Context
}

Export-ModuleMember -Function @(
    "New-EnglishStudyRuntimeContext",
    "Get-EnglishStudyRuntimeStatus",
    "Invoke-EnglishStudyLifecycleAction"
)
