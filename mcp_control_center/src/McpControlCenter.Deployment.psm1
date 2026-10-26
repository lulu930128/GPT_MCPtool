Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$script:Utf8 = New-Object Text.UTF8Encoding($false)

# Exact public code inventory. No recursive checkout/config/dependency copy.
$script:CodeFiles = @(
    'src/McpControlCenter.Core.psm1', 'src/McpControlCenter.Deployment.psm1',
    'src/McpControlCenter.WorkspaceLocal.psm1', 'src/WorkspaceLocal.Native.cs',
    'src/McpControlCenter.SelfReload.psm1', 'src/McpControlCenter.SelfReload.Owner.psm1',
    'src/RemoteSelfReload.Native.cs', 'src/McpControlCenter.InstalledRelease.psm1',
    'src/InstalledRelease.Native.cs', 'src/McpControlCenter.NormalOperator.psm1',
    'src/NormalOperator.Security.cs', 'src/NormalOperator.Pipe.cs',
    'src/NormalOperator.Native.cs', 'src/NormalOperator.Host.cs', 'src/NormalOperator.Execution.cs',
    'src/McpControlCenter.ReadOnlyG2.psm1', 'src/ReadOnlyG2.Native.cs', 'src/NormalMarkerOperator.mjs',
    'scripts/tray.ps1', 'scripts/control-center.ps1', 'scripts/component-health.ps1',
    'scripts/invoke-component-controller.ps1', 'scripts/startup.ps1', 'scripts/start-tray.vbs',
    'scripts/start-runtime-tray.ps1', 'scripts/start-runtime-tray.vbs',
    'scripts/runtime-update.ps1', 'config/registry.json'
)

function Assert-CcDeploymentPath([string]$Path) {
    if ($Path -notmatch '^[A-Za-z]:[\\/]' -or $Path -match '["\r\n]|(^|[\\/])\.\.([\\/]|$)') { throw 'CC_PATH_INVALID' }
    $cursor = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'CC_REPARSE_REJECTED' }
        }
        $cursor = Split-Path -Parent $cursor
    }
}

function Read-CcDeploymentJson([string]$Path) {
    Assert-CcDeploymentPath $Path
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -or $item.Length -gt 131072) { throw 'CC_JSON_LIMIT' }
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Assert-CcVersion([string]$Version) {
    if ($Version -cnotmatch '^[a-z0-9][a-z0-9_-]{0,47}$') { throw 'CC_VERSION_INVALID' }
}

function Get-McpCcDeploymentLayout([string]$ManagerRoot) {
    $manager = [IO.Path]::GetFullPath($ManagerRoot).TrimEnd('\')
    $versions = Split-Path -Parent $manager
    $runtime = Split-Path -Parent $versions
    $source = Split-Path -Parent $runtime
    $marker = Join-Path $manager 'cc-runtime.json'
    $nested = (Split-Path -Leaf $versions) -ieq 'versions' -and (Split-Path -Leaf $runtime) -ieq 'Runtime' -and (Split-Path -Leaf $source) -ieq 'mcp_control_center'
    if (-not $nested -and -not (Test-Path -LiteralPath $marker)) { return $null }
    if (-not $nested) { throw 'CC_LAYOUT_INVALID' }
    Assert-CcDeploymentPath $manager
    Assert-CcVersion (Split-Path -Leaf $manager)
    $mode = Read-CcDeploymentJson $marker
    if ($mode.contract -cne 'mcpcc-runtime-v1' -or $mode.version -cne (Split-Path -Leaf $manager)) { throw 'CC_LAYOUT_INVALID' }
    if (Test-Path -LiteralPath (Join-Path $manager 'config\installed-release.json')) { throw 'CC_LEGACY_LAYOUT_REJECTED' }
    return [pscustomobject]@{ managerRoot=$manager; runtimeRoot=$runtime; sourceRoot=$source;
        workspaceRoot=(Split-Path -Parent $source); stateRoot=(Join-Path $source '.local\runtime'); version=$mode.version }
}

function Get-McpCcBridgeDeployment([string]$WorkspaceRoot, [switch]$IncludeState) {
    $runtime = Join-Path $WorkspaceRoot 'codex_bridge\Runtime'
    $selectorPath = Join-Path $runtime 'current.json'
    if (-not (Test-Path -LiteralPath $selectorPath)) { throw 'CC_BRIDGE_SELECTION_UNAVAILABLE' }
    $selector = Read-CcDeploymentJson $selectorPath
    if ($selector.contract -cne 'mcpcc-daily-current-v1') { throw 'CC_BRIDGE_SELECTOR_INVALID' }
    Assert-CcVersion $selector.version
    $release = Join-Path $runtime ('versions\' + $selector.version)
    $mode = Read-CcDeploymentJson (Join-Path $release 'daily-mode.json')
    if ($mode.contract -cne 'mcpcc-daily-user-v1') { throw 'CC_BRIDGE_LAYOUT_INVALID' }
    $root = Join-Path $release 'codex_bridge'
    foreach ($relative in @('control-center\component.json','scripts\runtime-control.ps1')) {
        $path = Join-Path $root $relative
        Assert-CcDeploymentPath $path
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'CC_BRIDGE_ENTRY_MISSING' }
    }
    $result = [pscustomobject]@{ version=$selector.version; root=$root; controller=(Join-Path $root 'scripts\runtime-control.ps1') }
    if ($IncludeState) {
        # Bridge-owned paths-only contract. Never open any referenced state/secret file.
        $settings = Read-CcDeploymentJson (Join-Path $runtime 'settings.json')
        if ($settings.contract -cne 'mcpcc-daily-user-v1') { throw 'CC_BRIDGE_SETTINGS_INVALID' }
        foreach ($name in @('bridgeRuntimeDir','tunnelClientPath')) {
            $path = [string]$settings.$name
            Assert-CcDeploymentPath $path
            $full = [IO.Path]::GetFullPath($path).TrimEnd('\')
            if ($full -ine $path -or $full -imatch '^C:\\Program Files\\McpCcReleases(?:\\|$)' -or
                $full -ieq $runtime -or $full.StartsWith($runtime+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'CC_BRIDGE_STATE_CODE_OVERLAP' }
            $result | Add-Member -NotePropertyName $name -NotePropertyValue $full
        }
    }
    # Never combine two selector generations during a concurrent Bridge update.
    $again = Read-CcDeploymentJson $selectorPath
    if ($again.contract -cne $selector.contract -or $again.version -cne $selector.version) { throw 'CC_BRIDGE_SELECTION_CHANGED' }
    return $result
}

function Resolve-McpCcDeploymentComponentRoot($Layout, [string]$Id, [string]$RootToken, $Bridge) {
    $folders = @{ project_reading='project_reading'; omi_search='OMI_search'; japanese_study='japanese_study';
        memory_core='Memory Core'; codex_bridge='codex_bridge'; personal_asset_os='personal-asset-os';
        english_study='english_study'; listening_audio='listening_audio' }
    if (-not $folders.ContainsKey($Id) -or $RootToken -cne ('..\..\'+$folders[$Id])) { throw 'CC_COMPONENT_ROOT_INVALID' }
    if ($Id -ceq 'codex_bridge') { return $Bridge.root }
    $path = Join-Path $Layout.workspaceRoot $folders[$Id]
    Assert-CcDeploymentPath $path
    return $path
}

function Get-CcCodeInventory([string]$Root) {
    # Preflight every allowlisted path before reading bytes. Unlisted files are never read.
    foreach ($relative in $script:CodeFiles) {
        $path = Join-Path $Root $relative
        Assert-CcDeploymentPath $path
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw ('CC_CODE_MISSING: '+$relative) }
    }
    foreach ($relative in $script:CodeFiles | Sort-Object) {
        $path = Join-Path $Root $relative
        [pscustomobject]@{ path=$relative; sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }
    }
}

function Write-CcNewJson([string]$Path, $Value) {
    Assert-CcDeploymentPath $Path
    $bytes = $script:Utf8.GetBytes(($Value | ConvertTo-Json -Depth 8))
    $stream = [IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}

function Open-CcUpdateLock([string]$Root) {
    Assert-CcDeploymentPath $Root
    [void][IO.Directory]::CreateDirectory($Root)
    $path = Join-Path $Root 'update.lock'
    Assert-CcDeploymentPath $path
    # Single exclusive file handle for Stage and selection; no stale-PID lock breaking.
    return [IO.File]::Open($path,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
}

function Test-McpCcDeploymentVersion([string]$Root, [string]$Version) {
    Assert-CcVersion $Version
    $path = Join-Path $Root ('versions\'+$Version)
    $layout = Get-McpCcDeploymentLayout $path
    if ($null -eq $layout) { throw 'CC_LAYOUT_INVALID' }
    $receipt = Read-CcDeploymentJson (Join-Path $path 'code-inventory.json')
    if ($receipt.contract -cne 'mcpcc-code-inventory-v1' -or $receipt.version -cne $Version) { throw 'CC_INVENTORY_INVALID' }
    $actual = @(Get-CcCodeInventory $path)
    if (($actual | ConvertTo-Json -Compress) -cne (@($receipt.files) | ConvertTo-Json -Compress)) { throw 'CC_COPY_INTEGRITY_FAILED' }
    # Version trees contain exactly the inventory plus two generated code metadata files.
    $expected = @($script:CodeFiles) + @('cc-runtime.json','code-inventory.json')
    $queue = New-Object 'Collections.Generic.Stack[string]'
    $queue.Push($path)
    $count = 0
    while ($queue.Count) {
        foreach ($item in Get-ChildItem -LiteralPath $queue.Pop() -Force) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'CC_REPARSE_REJECTED' }
            if ($item.PSIsContainer) { $queue.Push($item.FullName) }
            else {
                $relative = $item.FullName.Substring($path.Length+1).Replace('\','/')
                if ($relative -cnotin $expected) { throw 'CC_UNLISTED_CODE_FILE' }
                $count++
            }
        }
    }
    if ($count -ne $expected.Count) { throw 'CC_INVENTORY_INVALID' }
    return $layout
}

function New-McpCcDeploymentCandidate([string]$SourceRoot, [string]$Version) {
    Assert-CcVersion $Version
    $SourceRoot = [IO.Path]::GetFullPath($SourceRoot).TrimEnd('\')
    if ((Split-Path -Leaf $SourceRoot) -ine 'mcp_control_center') { throw 'CC_SOURCE_ROOT_INVALID' }
    Assert-CcDeploymentPath $SourceRoot
    if (Test-Path -LiteralPath (Join-Path $SourceRoot 'config\installed-release.json')) { throw 'CC_LEGACY_LAYOUT_REJECTED' }
    $root = Join-Path $SourceRoot 'Runtime'
    $lock = Open-CcUpdateLock $root
    try {
        $target = Join-Path $root ('versions\'+$Version)
        Assert-CcDeploymentPath $target
        if (Test-Path -LiteralPath $target) { throw 'CC_VERSION_EXISTS' }
        $before = @(Get-CcCodeInventory $SourceRoot)
        $registry = Read-CcDeploymentJson (Join-Path $SourceRoot 'config\registry.json')
        if ($registry.schemaVersion -ne 3 -or @($registry.components).Count -ne 8) { throw 'CC_REGISTRY_V3_EIGHT_REQUIRED' }
        $pending = Join-Path $root ('staging\'+[guid]::NewGuid().ToString('N'))
        Assert-CcDeploymentPath $pending
        [void][IO.Directory]::CreateDirectory($pending)
        foreach ($file in $before) {
            $from = Join-Path $SourceRoot $file.path
            $to = Join-Path $pending $file.path
            Assert-CcDeploymentPath $from
            Assert-CcDeploymentPath $to
            [void][IO.Directory]::CreateDirectory((Split-Path -Parent $to))
            [IO.File]::Copy($from,$to,$false)
        }
        $copied = @(Get-CcCodeInventory $pending)
        $after = @(Get-CcCodeInventory $SourceRoot)
        $json = $before | ConvertTo-Json -Compress
        if ($json -cne ($copied | ConvertTo-Json -Compress) -or $json -cne ($after | ConvertTo-Json -Compress)) { throw 'CC_SOURCE_CHANGED_OR_COPY_FAILED' }
        Write-CcNewJson (Join-Path $pending 'cc-runtime.json') @{ contract='mcpcc-runtime-v1'; version=$Version }
        Write-CcNewJson (Join-Path $pending 'code-inventory.json') @{ contract='mcpcc-code-inventory-v1'; version=$Version; files=$before }
        [void][IO.Directory]::CreateDirectory((Join-Path $root 'versions'))
        [IO.Directory]::Move($pending,$target)
        $null = Test-McpCcDeploymentVersion $root $Version
        return [pscustomobject]@{ phase='STAGED'; version=$Version; codeRoot=$target; fileCount=$before.Count;
            selected=$false; live='UNVERIFIED'; startupChanged=$false; stateMoved=$false }
    } finally { $lock.Dispose() }
}

function Get-McpCcDeploymentStatus([string]$SourceRoot) {
    $root = Join-Path $SourceRoot 'Runtime'
    Assert-CcDeploymentPath $root
    $selected = $null
    $selectorPath = Join-Path $root 'current.json'
    if (Test-Path -LiteralPath $selectorPath) {
        $selector = Read-CcDeploymentJson $selectorPath
        if ($selector.contract -cne 'mcpcc-current-v1') { throw 'CC_SELECTOR_INVALID' }
        $selected = (Test-McpCcDeploymentVersion $root $selector.version).version
    }
    $versions = @()
    $versionsPath = Join-Path $root 'versions'
    Assert-CcDeploymentPath $versionsPath
    if (Test-Path -LiteralPath $versionsPath) {
        $versions = @(foreach ($dir in Get-ChildItem -LiteralPath $versionsPath -Directory) {
            try {
                $layout = Test-McpCcDeploymentVersion $root $dir.Name
                [pscustomobject]@{version=$layout.version; codeRoot=$layout.managerRoot; integrity='PASS'; reason=$null}
            } catch {
                # A damaged inactive candidate must not prevent recovery to the
                # valid selected version. Inspect names only; do not follow it.
                $reason = if ($_.Exception.Message -cmatch '^CC_[A-Z_]+$') { $_.Exception.Message } else { 'CC_VERSION_INSPECTION_FAILED' }
                [pscustomobject]@{version=$dir.Name; codeRoot=$dir.FullName; integrity='FAIL'; reason=$reason}
            }
        })
    }
    $bridge = $null; $bridgeCode = 'UNVERIFIED'
    try { $bridge = Get-McpCcBridgeDeployment (Split-Path -Parent $SourceRoot); $bridgeCode = 'SELECTED_NOT_LIVE_VERIFIED' }
    catch {
        if ($_.Exception.Message -cmatch '^CC_[A-Z_]+$') { $bridgeCode=$_.Exception.Message }
        else { $bridgeCode='CC_BRIDGE_INSPECTION_UNAVAILABLE' }
    }
    return [pscustomobject]@{runtimeRoot=$root; stateRoot=(Join-Path $SourceRoot '.local\runtime'); selected=$selected;
        versions=$versions; bridge=$bridge; bridgeStatus=$bridgeCode; live='UNVERIFIED'; startupChanged=$false; stateMoved=$false}
}

function Enter-CcStoppedTray {
    $created = $false
    $mutex = New-Object Threading.Mutex($true,'Local\McpControlCenterTray',[ref]$created)
    if (-not $created) { $mutex.Dispose(); throw 'CC_TRAY_PRESENT_USE_ORDINARY_EXIT' }
    return $mutex
}

function Assert-McpCcDeploymentSelected($Layout) {
    $selector = Read-CcDeploymentJson (Join-Path $Layout.runtimeRoot 'current.json')
    if ($selector.contract -cne 'mcpcc-current-v1' -or $selector.version -cne $Layout.version) { throw 'CC_SELECTION_CHANGED' }
    $null = Test-McpCcDeploymentVersion $Layout.runtimeRoot $Layout.version
}

function New-McpCcDeploymentTrayStartInfo($Layout, [switch]$Boot) {
    $tray = Join-Path $Layout.managerRoot 'scripts\tray.ps1'
    Assert-CcDeploymentPath $tray
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = Join-Path $PSHOME 'powershell.exe'
    $info.Arguments = '-NoProfile -WindowStyle Hidden -File "'+$tray+'"'
    if ($Boot) { $info.Arguments += ' -AutoReconcile' }
    $info.WorkingDirectory = $Layout.managerRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.EnvironmentVariables['PSModulePath'] = Join-Path $PSHOME 'Modules'
    return $info
}

# Selection is deliberately stopped-only. Existing tray Exit owns busy/drain checks.
# No process termination, automatic retry, Startup change or component action here.
function Set-McpCcDeploymentSelection([string]$SourceRoot, [string]$Version) {
    $root = Join-Path $SourceRoot 'Runtime'
    $lock = Open-CcUpdateLock $root
    $singleton = $null; $owned = $false
    try {
        $singleton = Enter-CcStoppedTray
        $owned = $true
        $layout = Test-McpCcDeploymentVersion $root $Version
        $bridge = Get-McpCcBridgeDeployment $layout.workspaceRoot
        $path = Join-Path $root 'current.json'
        Assert-CcDeploymentPath $path
        $temp = Join-Path $root ('current-'+[guid]::NewGuid().ToString('N')+'.tmp')
        Write-CcNewJson $temp @{contract='mcpcc-current-v1';version=$Version}
        if (Test-Path -LiteralPath $path) {
            $old = Read-CcDeploymentJson $path
            if ($old.contract -cne 'mcpcc-current-v1') { throw 'CC_SELECTOR_INVALID' }
            $null = Test-McpCcDeploymentVersion $root $old.version
            # Unique backup retains exact old selector bytes for explicit recovery.
            [IO.File]::Replace($temp,$path,(Join-Path $root ('previous-'+[guid]::NewGuid().ToString('N')+'.json')))
        } else { [IO.File]::Move($temp,$path) }
        return [pscustomobject]@{phase='SELECTED_NOT_STARTED';version=$Version;bridge=$bridge;live='UNVERIFIED'}
    } finally {
        if ($owned) { $singleton.ReleaseMutex() }
        if ($null -ne $singleton) { $singleton.Dispose() }
        $lock.Dispose()
    }
}

Export-ModuleMember -Function Get-McpCcDeploymentLayout,Get-McpCcBridgeDeployment,Resolve-McpCcDeploymentComponentRoot,New-McpCcDeploymentCandidate,Get-McpCcDeploymentStatus,Test-McpCcDeploymentVersion,Set-McpCcDeploymentSelection,Assert-McpCcDeploymentSelected,New-McpCcDeploymentTrayStartInfo
