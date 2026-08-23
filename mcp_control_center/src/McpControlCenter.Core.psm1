Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$script:ExpectedTrayContract = "unified-always-on-v2"
$script:ExpectedLifecycleContract = "unified-lifecycle-v3"
$script:ExpectedComponentMenuContract = "component-menu-v1"
$script:ControllerCapabilities = @(
    "ensure_running",
    "repair_connectivity",
    "restart_core",
    "reload_runtime",
    "shutdown_runtime",
    "show_diagnostic_tray"
)
$script:ComponentTraits = @(
    "tunnel",
    "external-dependency",
    "multi-core",
    "data-sensitive",
    "credential-sensitive",
    "approval-sensitive",
    "primary-ui",
    "diagnostic-ui"
)
$script:SafeSummaryFields = @(
    "service",
    "status",
    "version",
    "buildId",
    "contractVersion",
    "toolCount",
    "database",
    "schemaRevision",
    "ready",
    "databaseReady",
    "frontendReady",
    "errorCode"
)
$script:MaximumRegistryComponents = 64
$script:MaximumConfigBytes = 131072
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Get-McpCcDefaultManifestPath {
    $moduleRoot = Split-Path -Parent $PSScriptRoot
    $registryPath = Join-Path $moduleRoot "config\registry.json"
    if (Test-Path -LiteralPath $registryPath -PathType Leaf) {
        return $registryPath
    }
    return Join-Path $moduleRoot "config\components.json"
}

function Get-McpCcDefaultRuntimeRoot {
    if (-not [string]::IsNullOrWhiteSpace($env:MCP_CONTROL_CENTER_DATA_DIR)) {
        return [IO.Path]::GetFullPath($env:MCP_CONTROL_CENTER_DATA_DIR)
    }
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw "LOCALAPPDATA is unavailable; set MCP_CONTROL_CENTER_DATA_DIR to a private runtime directory."
    }
    return Join-Path $env:LOCALAPPDATA "McpControlCenter"
}

function Get-McpCcBootId {
    try {
        $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
        $boot = [DateTime]$os.LastBootUpTime
        return "boot-$($boot.ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))"
    }
    catch {
        return "session-$PID-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))"
    }
}

function Test-McpCcPathWithinRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )
    $resolvedPath = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    if ($resolvedPath.Equals($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    return $resolvedPath.StartsWith($resolvedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Resolve-McpCcChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [string]$Label = "path"
    )
    if ([IO.Path]::IsPathRooted($RelativePath)) {
        throw "$Label must be relative to its component root."
    }
    $resolved = [IO.Path]::GetFullPath((Join-Path $Root $RelativePath))
    if (-not (Test-McpCcPathWithinRoot -Path $resolved -Root $Root)) {
        throw "$Label escapes its component root."
    }
    if ((Test-Path -LiteralPath $Root) -and (Test-Path -LiteralPath $resolved)) {
        $physicalRoot = (Resolve-Path -LiteralPath $Root -ErrorAction Stop).Path
        $physicalResolved = (Resolve-Path -LiteralPath $resolved -ErrorAction Stop).Path
        if (-not (Test-McpCcPathWithinRoot -Path $physicalResolved -Root $physicalRoot)) {
            throw "$Label escapes its component root after filesystem resolution."
        }
        return $physicalResolved
    }
    return $resolved
}

function Assert-McpCcLoopbackUrl {
    param([Parameter(Mandatory = $true)][string]$Url)
    $uri = $null
    if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$uri)) {
        throw "Invalid probe URL: $Url"
    }
    if ($uri.Scheme -ne "http") {
        throw "Probe URL must use local HTTP: $Url"
    }
    if ($uri.Host -notin @("127.0.0.1", "localhost", "::1", "[::1]")) {
        throw "Probe URL must use a loopback host: $Url"
    }
    if (-not [string]::IsNullOrWhiteSpace($uri.UserInfo)) {
        throw "Probe URL must not contain credentials: $Url"
    }
}

function Get-McpCcObjectProperty {
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )
    if ($null -eq $Object) {
        return [pscustomobject]@{ found = $false; value = $null }
    }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) {
            return [pscustomobject]@{ found = $true; value = $Object[$Name] }
        }
        return [pscustomobject]@{ found = $false; value = $null }
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return [pscustomobject]@{ found = $false; value = $null }
    }
    return [pscustomobject]@{ found = $true; value = $property.Value }
}

function Assert-McpCcObjectShape {
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string[]]$Allowed,
        [string[]]$Required = @(),
        [Parameter(Mandatory = $true)][string]$Label
    )
    if ($null -eq $Object -or $Object -is [string] -or $Object -is [ValueType] -or $Object -is [System.Array]) {
        throw "$Label must be an object."
    }
    $propertyNames = @($Object.PSObject.Properties.Name | ForEach-Object { [string]$_ })
    $unknown = @($propertyNames | Where-Object { $_ -notin $Allowed })
    if ($unknown.Count -gt 0) {
        throw "$Label contains unsupported field(s): $($unknown -join ', ')."
    }
    $missing = @($Required | Where-Object { $_ -notin $propertyNames })
    if ($missing.Count -gt 0) {
        throw "$Label is missing required field(s): $($missing -join ', ')."
    }
}

function Read-McpCcJsonFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Label = "JSON document",
        [int]$MaximumBytes = $script:MaximumConfigBytes
    )
    $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    $item = Get-Item -LiteralPath $resolved -ErrorAction Stop
    if ($item.Length -gt $MaximumBytes) {
        throw "$Label exceeds the $MaximumBytes byte limit."
    }
    try {
        $document = Get-Content -LiteralPath $resolved -Encoding UTF8 -Raw | ConvertFrom-Json
    }
    catch {
        throw "Invalid $Label at $resolved. $($_.Exception.Message)"
    }
    return [pscustomobject]@{ path = $resolved; document = $document }
}

function Assert-McpCcIntegerRange {
    param(
        $Value,
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][int]$Minimum,
        [Parameter(Mandatory = $true)][int]$Maximum
    )
    if ($Value -isnot [int] -and $Value -isnot [long]) {
        throw "$Label must be an integer."
    }
    $number = [long]$Value
    if ($number -lt $Minimum -or $number -gt $Maximum) {
        throw "$Label must be between $Minimum and $Maximum."
    }
    return [int]$number
}

function Assert-McpCcBoolean {
    param($Value, [Parameter(Mandatory = $true)][string]$Label)
    if ($Value -isnot [bool]) { throw "$Label must be boolean." }
}

function Assert-McpCcStringList {
    param(
        $Value,
        [Parameter(Mandatory = $true)][string]$Label,
        [string[]]$Allowed,
        [int]$MinimumCount = 0,
        [int]$MaximumCount = 64
    )
    if ($null -eq $Value -or $Value -is [string]) {
        throw "$Label must be an array."
    }
    $rawItems = @($Value)
    if (@($rawItems | Where-Object { $_ -isnot [string] }).Count -gt 0) {
        throw "$Label must contain strings only."
    }
    $items = @($rawItems | ForEach-Object { [string]$_ })
    if ($items.Count -lt $MinimumCount -or $items.Count -gt $MaximumCount) {
        throw "$Label must contain between $MinimumCount and $MaximumCount entries."
    }
    if (@($items | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -gt 0) {
        throw "$Label must not contain blank entries."
    }
    if (@($items | Select-Object -Unique).Count -ne $items.Count) {
        throw "$Label must not contain duplicate entries."
    }
    if ($null -ne $Allowed -and @($Allowed).Count -gt 0) {
        $unknown = @($items | Where-Object { $_ -notin $Allowed })
        if ($unknown.Count -gt 0) { throw "$Label contains unsupported value(s): $($unknown -join ', ')." }
    }
    return [string[]]$items
}

function Test-McpCcJsonScalar {
    param($Value)
    return $null -eq $Value -or $Value -is [string] -or $Value -is [bool] -or $Value -is [ValueType]
}

function Get-McpCcNestedProperty {
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $current = $Object
    foreach ($segment in $Path.Split('.')) {
        $result = Get-McpCcObjectProperty -Object $current -Name $segment
        if (-not $result.found) {
            return [pscustomobject]@{ found = $false; value = $null }
        }
        $current = $result.value
    }
    return [pscustomobject]@{ found = $true; value = $current }
}

function Test-McpCcValueEqual {
    param($Actual, $Expected)
    if ($null -eq $Expected) { return $null -eq $Actual }
    if ($null -eq $Actual) { return $false }
    if ($Expected -is [bool]) {
        return ($Actual -is [bool] -and [bool]$Actual -eq [bool]$Expected)
    }
    if ($Expected -is [ValueType] -and $Expected -isnot [char]) {
        return ([string]$Actual).Equals([string]$Expected, [StringComparison]::Ordinal)
    }
    return ([string]$Actual).Equals([string]$Expected, [StringComparison]::Ordinal)
}

function Get-McpCcRuntimeMode {
    param([Parameter(Mandatory = $true)]$Component)
    $modeResult = Get-McpCcObjectProperty -Object $Component -Name "runtimeMode"
    if (-not $modeResult.found -or [string]::IsNullOrWhiteSpace([string]$modeResult.value)) {
        return "legacy-tray"
    }
    return [string]$modeResult.value
}

function Get-McpCcRequiredActionNames {
    param([Parameter(Mandatory = $true)]$Component)
    if ((Get-McpCcRuntimeMode -Component $Component) -eq "component-controller") {
        return @($Component.capabilities)
    }
    return @("start", "restart")
}

function Get-McpCcComponentActionBinding {
    param(
        [Parameter(Mandatory = $true)]$Component,
        [Parameter(Mandatory = $true)][ValidateSet(
            "start",
            "restart",
            "ensure_running",
            "repair_connectivity",
            "restart_core",
            "reload_runtime",
            "shutdown_runtime",
            "show_diagnostic_tray"
        )][string]$Action
    )
    $semanticAction = switch ($Action) {
        "start" { "ensure_running" }
        "restart" { "reload_runtime" }
        default { $Action }
    }
    $runtimeMode = Get-McpCcRuntimeMode -Component $Component
    if ($runtimeMode -eq "legacy-tray") {
        $manifestAction = switch ($semanticAction) {
            "ensure_running" { "start" }
            "reload_runtime" { "restart" }
            default { throw "Component '$($Component.id)' in legacy-tray mode does not support '$semanticAction'." }
        }
        $standardArguments = @()
    }
    elseif ($runtimeMode -eq "component-controller") {
        if ($semanticAction -notin $script:ControllerCapabilities -or $semanticAction -notin @($Component.capabilities)) {
            throw "Component '$($Component.id)' does not support lifecycle action '$semanticAction'."
        }
        $manifestAction = $semanticAction
        $standardArguments = switch ($semanticAction) {
            "ensure_running" { @("-Action", "EnsureRunning") }
            "repair_connectivity" { @("-Action", "RepairConnectivity") }
            "restart_core" { @("-Action", "RestartCore") }
            "reload_runtime" { @("-Action", "ReloadRuntime") }
            "shutdown_runtime" { @("-Action", "ShutdownRuntime") }
            "show_diagnostic_tray" { @() }
        }
    }
    else {
        throw "Component '$($Component.id)' has unsupported runtimeMode '$runtimeMode'."
    }
    $actionResult = Get-McpCcObjectProperty -Object $Component.actions -Name $manifestAction
    if (-not $actionResult.found) {
        throw "Component '$($Component.id)' is missing action '$manifestAction'."
    }
    return [pscustomobject]@{
        semanticAction = $semanticAction
        manifestAction = $manifestAction
        runtimeMode = $runtimeMode
        actionSpec = $actionResult.value
        standardArguments = @($standardArguments)
    }
}

function Get-McpCcComponentTimingSeconds {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)]$Component,
        [Parameter(Mandatory = $true)][ValidateSet("postStartTimeoutSeconds", "controllerActionTimeoutSeconds")][string]$Name
    )
    $timingResult = Get-McpCcObjectProperty -Object $Component -Name "timing"
    if ($timingResult.found -and $null -ne $timingResult.value) {
        $overrideResult = Get-McpCcObjectProperty -Object $timingResult.value -Name $Name
        if ($overrideResult.found) { return [int]$overrideResult.value }
    }
    return [int]$Manifest.settings.$Name
}

function Read-McpCcLegacyManifest {
    param([string]$Path = (Get-McpCcDefaultManifestPath))
    $manifestPath = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Encoding UTF8 -Raw | ConvertFrom-Json
    }
    catch {
        throw "Invalid control-center manifest at $manifestPath. $($_.Exception.Message)"
    }
    if ([int]$manifest.schemaVersion -notin @(1, 2)) {
        throw "Unsupported manifest schemaVersion '$($manifest.schemaVersion)'."
    }
    if ($null -eq $manifest.settings -or @($manifest.components).Count -ne 6) {
        throw "The manifest must define settings and exactly six MCP components."
    }

    foreach ($setting in @(
        @{ Name = "initialDelaySeconds"; Min = 0; Max = 300 },
        @{ Name = "betweenComponentsSeconds"; Min = 0; Max = 60 },
        @{ Name = "probeTimeoutSeconds"; Min = 1; Max = 15 },
        @{ Name = "postStartTimeoutSeconds"; Min = 5; Max = 300 },
        @{ Name = "refreshIntervalSeconds"; Min = 10; Max = 3600 },
        @{ Name = "eventRetentionDays"; Min = 1; Max = 365 }
    )) {
        $valueResult = Get-McpCcObjectProperty -Object $manifest.settings -Name $setting.Name
        if (-not $valueResult.found -or [int]$valueResult.value -lt $setting.Min -or [int]$valueResult.value -gt $setting.Max) {
            throw "Manifest setting '$($setting.Name)' must be between $($setting.Min) and $($setting.Max)."
        }
    }
    $controllerTimeoutResult = Get-McpCcObjectProperty -Object $manifest.settings -Name "controllerActionTimeoutSeconds"
    if ($controllerTimeoutResult.found) {
        if ([int]$controllerTimeoutResult.value -lt 5 -or [int]$controllerTimeoutResult.value -gt 300) {
            throw "Manifest setting 'controllerActionTimeoutSeconds' must be between 5 and 300."
        }
    }
    else {
        $manifest.settings | Add-Member -NotePropertyName controllerActionTimeoutSeconds -NotePropertyValue ([int]$manifest.settings.postStartTimeoutSeconds) -Force
    }

    $manifestDirectory = Split-Path -Parent $manifestPath
    $managerRoot = Split-Path -Parent $manifestDirectory
    $workspaceRoot = Split-Path -Parent $managerRoot
    $ids = @{}
    foreach ($component in @($manifest.components)) {
        if ([string]::IsNullOrWhiteSpace([string]$component.id) -or [string]$component.id -notmatch '^[a-z][a-z0-9_]*$') {
            throw "Every component requires a stable lowercase id."
        }
        if ($ids.ContainsKey([string]$component.id)) {
            throw "Duplicate component id '$($component.id)'."
        }
        $ids[[string]$component.id] = $true
        if ([string]::IsNullOrWhiteSpace([string]$component.displayName)) {
            throw "Component '$($component.id)' requires displayName."
        }
        $resolvedRoot = [IO.Path]::GetFullPath((Join-Path $manifestDirectory ([string]$component.root)))
        $resolvedParent = Split-Path -Parent $resolvedRoot
        if (-not $resolvedParent.Equals($workspaceRoot, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Component '$($component.id)' root must be a direct child of the workspace root."
        }
        $component | Add-Member -NotePropertyName resolvedRoot -NotePropertyValue $resolvedRoot -Force

        $runtimeModeResult = Get-McpCcObjectProperty -Object $component -Name "runtimeMode"
        if ([int]$manifest.schemaVersion -eq 1) {
            if ($runtimeModeResult.found -and [string]$runtimeModeResult.value -ne "legacy-tray") {
                throw "Component '$($component.id)' requires manifest schemaVersion 2 for runtimeMode '$($runtimeModeResult.value)'."
            }
            $component | Add-Member -NotePropertyName runtimeMode -NotePropertyValue "legacy-tray" -Force
        }
        else {
            if (-not $runtimeModeResult.found -or [string]$runtimeModeResult.value -notin @("legacy-tray", "component-controller")) {
                throw "Component '$($component.id)' requires runtimeMode 'legacy-tray' or 'component-controller'."
            }
        }
        $runtimeMode = Get-McpCcRuntimeMode -Component $component

        $contractScriptResult = Get-McpCcObjectProperty -Object $component -Name "contractScript"
        if (-not $contractScriptResult.found) {
            throw "Component '$($component.id)' requires contractScript."
        }
        $contractScript = Resolve-McpCcChildPath -Root $resolvedRoot -RelativePath ([string]$contractScriptResult.value) -Label "contractScript"
        $component | Add-Member -NotePropertyName resolvedContractScript -NotePropertyValue $contractScript -Force

        $component | Add-Member -NotePropertyName capabilities -NotePropertyValue $(
            if ($runtimeMode -eq "component-controller") { @($script:ControllerCapabilities) }
            else { @("ensure_running", "reload_runtime") }
        ) -Force
        $requiredActionNames = @(Get-McpCcRequiredActionNames -Component $component)
        foreach ($actionName in $requiredActionNames) {
            $actionResult = Get-McpCcObjectProperty -Object $component.actions -Name $actionName
            if (-not $actionResult.found) {
                throw "Component '$($component.id)' requires '$actionName' action."
            }
            $action = $actionResult.value
            if ([string]$action.kind -notin @("vbs", "powershell")) {
                throw "Component '$($component.id)' action '$actionName' has unsupported kind '$($action.kind)'."
            }
            $null = Resolve-McpCcChildPath -Root $resolvedRoot -RelativePath ([string]$action.path) -Label "$actionName action"
            if ($runtimeMode -eq "component-controller") {
                if ($actionName -eq "show_diagnostic_tray" -and [string]$action.kind -ne "vbs") {
                    throw "Component '$($component.id)' action 'show_diagnostic_tray' must use a vbs launcher."
                }
                if ($actionName -ne "show_diagnostic_tray" -and [string]$action.kind -ne "powershell") {
                    throw "Component '$($component.id)' action '$actionName' must use a PowerShell lifecycle controller."
                }
                $argumentsResult = Get-McpCcObjectProperty -Object $action -Name "arguments"
                if ($argumentsResult.found) {
                    throw "Component '$($component.id)' controller action '$actionName' must not declare arbitrary arguments."
                }
            }
        }
        if (@($component.probes).Count -lt 2) {
            throw "Component '$($component.id)' requires core and connectivity probes."
        }
        $probeIds = @{}
        foreach ($probe in @($component.probes)) {
            if ([string]::IsNullOrWhiteSpace([string]$probe.id) -or $probeIds.ContainsKey([string]$probe.id)) {
                throw "Component '$($component.id)' has an invalid or duplicate probe id."
            }
            $probeIds[[string]$probe.id] = $true
            if ([string]$probe.kind -notin @("json", "text")) {
                throw "Probe '$($component.id)/$($probe.id)' has unsupported kind '$($probe.kind)'."
            }
            if ([string]$probe.role -notin @("core", "dependency", "connectivity")) {
                throw "Probe '$($component.id)/$($probe.id)' has unsupported role '$($probe.role)'."
            }
            Assert-McpCcLoopbackUrl -Url ([string]$probe.url)
            if ([int]$probe.port -lt 1 -or [int]$probe.port -gt 65535) {
                throw "Probe '$($component.id)/$($probe.id)' has an invalid port."
            }

            $managedPidFileResult = Get-McpCcObjectProperty -Object $probe -Name "ownerManagedPidFile"
            $managedFragmentsResult = Get-McpCcObjectProperty -Object $probe -Name "ownerManagedCommandContains"
            if ($managedFragmentsResult.found -and -not $managedPidFileResult.found) {
                throw "Probe '$($component.id)/$($probe.id)' requires ownerManagedPidFile when ownerManagedCommandContains is configured."
            }
            if ($managedPidFileResult.found) {
                if ([string]::IsNullOrWhiteSpace([string]$managedPidFileResult.value)) {
                    throw "Probe '$($component.id)/$($probe.id)' has an empty ownerManagedPidFile."
                }
                $managedPidPath = Resolve-McpCcChildPath `
                    -Root $resolvedRoot `
                    -RelativePath ([string]$managedPidFileResult.value) `
                    -Label "owner managed PID file"
                $probe | Add-Member -NotePropertyName resolvedOwnerManagedPidFile -NotePropertyValue $managedPidPath -Force
            }
        }
    }
    $manifest | Add-Member -NotePropertyName sourcePath -NotePropertyValue $manifestPath -Force
    $manifest | Add-Member -NotePropertyName managerRoot -NotePropertyValue $managerRoot -Force
    $manifest | Add-Member -NotePropertyName workspaceRoot -NotePropertyValue $workspaceRoot -Force
    return $manifest
}

function Assert-McpCcLauncherSpec {
    param(
        [Parameter(Mandatory = $true)]$Spec,
        [Parameter(Mandatory = $true)][ValidateSet("vbs", "powershell")][string]$Kind,
        [Parameter(Mandatory = $true)][string]$ComponentRoot,
        [Parameter(Mandatory = $true)][string]$Label
    )
    Assert-McpCcObjectShape -Object $Spec -Allowed @("kind", "path") -Required @("kind", "path") -Label $Label
    if ([string]$Spec.kind -ne $Kind) { throw "$Label must use kind '$Kind'." }
    $path = [string]$Spec.path
    if ([string]::IsNullOrWhiteSpace($path)) { throw "$Label requires a non-empty path." }
    $extension = if ($Kind -eq "vbs") { ".vbs" } else { ".ps1" }
    if (-not $path.EndsWith($extension, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label must reference a $extension file."
    }
    $null = Resolve-McpCcChildPath -Root $ComponentRoot -RelativePath $path -Label $Label
    return [pscustomobject]@{ kind = $Kind; path = $path }
}

function ConvertFrom-McpCcDescriptorProbe {
    param(
        [Parameter(Mandatory = $true)]$Probe,
        [Parameter(Mandatory = $true)][string]$ComponentId,
        [Parameter(Mandatory = $true)][string]$ComponentRoot
    )
    $label = "Probe '$ComponentId/$($Probe.id)'"
    Assert-McpCcObjectShape `
        -Object $Probe `
        -Allowed @("id", "label", "role", "kind", "url", "port", "required", "expected", "expectedText", "publicSummaryFields", "ownership") `
        -Required @("id", "label", "role", "kind", "url", "port", "required") `
        -Label $label

    if ([string]::IsNullOrWhiteSpace([string]$Probe.id) -or [string]$Probe.id -notmatch '^[a-z][a-z0-9_]{0,63}$') {
        throw "$label has an invalid id."
    }
    if ([string]::IsNullOrWhiteSpace([string]$Probe.label) -or ([string]$Probe.label).Length -gt 80) {
        throw "$label requires a label of at most 80 characters."
    }
    if ([string]$Probe.role -notin @("core", "dependency", "connectivity")) {
        throw "$label has unsupported role '$($Probe.role)'."
    }
    if ([string]$Probe.kind -notin @("json", "text")) {
        throw "$label has unsupported kind '$($Probe.kind)'."
    }
    Assert-McpCcBoolean -Value $Probe.required -Label "$label required"
    $port = Assert-McpCcIntegerRange -Value $Probe.port -Label "$label port" -Minimum 1 -Maximum 65535
    Assert-McpCcLoopbackUrl -Url ([string]$Probe.url)
    $uri = [Uri]([string]$Probe.url)
    if ($uri.Port -ne $port) { throw "$label URL port must match its declared port." }

    $expectedResult = Get-McpCcObjectProperty -Object $Probe -Name "expected"
    $expectedTextResult = Get-McpCcObjectProperty -Object $Probe -Name "expectedText"
    if ([string]$Probe.kind -eq "json") {
        if (-not $expectedResult.found -or $null -eq $expectedResult.value) { throw "$label requires expected JSON fields." }
        if ($expectedTextResult.found) { throw "$label must not declare expectedText for a JSON probe." }
        Assert-McpCcObjectShape -Object $expectedResult.value -Allowed @($expectedResult.value.PSObject.Properties.Name) -Label "$label expected"
        if (@($expectedResult.value.PSObject.Properties).Count -eq 0) { throw "$label expected must not be empty." }
        foreach ($property in $expectedResult.value.PSObject.Properties) {
            if (-not (Test-McpCcJsonScalar -Value $property.Value)) {
                throw "$label expected field '$($property.Name)' must be a top-level scalar."
            }
        }
    }
    else {
        if (-not $expectedTextResult.found) { throw "$label requires expectedText markers." }
        if ($expectedResult.found) { throw "$label must not declare expected for a text probe." }
        $null = Assert-McpCcStringList -Value $expectedTextResult.value -Label "$label expectedText" -MinimumCount 1 -MaximumCount 8
    }

    $summaryResult = Get-McpCcObjectProperty -Object $Probe -Name "publicSummaryFields"
    $summaryFields = if ($summaryResult.found) {
        @(Assert-McpCcStringList -Value $summaryResult.value -Label "$label publicSummaryFields" -Allowed $script:SafeSummaryFields -MaximumCount 16)
    }
    else { @() }

    $normalized = [ordered]@{
        id = [string]$Probe.id
        label = [string]$Probe.label
        role = [string]$Probe.role
        kind = [string]$Probe.kind
        url = [string]$Probe.url
        port = $port
        required = [bool]$Probe.required
        summaryFields = $summaryFields
        ownerCommandContains = @()
        ownerManagedPidFile = $null
        resolvedOwnerManagedPidFile = $null
        ownerManagedCommandContains = @()
    }
    if ($expectedResult.found) { $normalized["expected"] = $expectedResult.value }
    if ($expectedTextResult.found) { $normalized["expectedText"] = @($expectedTextResult.value | ForEach-Object { [string]$_ }) }

    $ownershipResult = Get-McpCcObjectProperty -Object $Probe -Name "ownership"
    if ($ownershipResult.found) {
        if ([string]$Probe.role -eq "dependency") { throw "$label dependency probes must not declare ownership." }
        Assert-McpCcObjectShape `
            -Object $ownershipResult.value `
            -Allowed @("commandContains", "managedPidFile", "managedCommandContains") `
            -Label "$label ownership"
        $commandResult = Get-McpCcObjectProperty -Object $ownershipResult.value -Name "commandContains"
        if ($commandResult.found) {
            $normalized["ownerCommandContains"] = @(Assert-McpCcStringList -Value $commandResult.value -Label "$label ownership.commandContains" -MinimumCount 1 -MaximumCount 8)
        }
        $pidResult = Get-McpCcObjectProperty -Object $ownershipResult.value -Name "managedPidFile"
        $managedCommandResult = Get-McpCcObjectProperty -Object $ownershipResult.value -Name "managedCommandContains"
        if ($managedCommandResult.found -and -not $pidResult.found) {
            throw "$label ownership.managedCommandContains requires managedPidFile."
        }
        if ($pidResult.found) {
            if ([string]::IsNullOrWhiteSpace([string]$pidResult.value)) { throw "$label ownership.managedPidFile must not be blank." }
            $managedPidPath = Resolve-McpCcChildPath -Root $ComponentRoot -RelativePath ([string]$pidResult.value) -Label "$label managed PID file"
            $normalized["ownerManagedPidFile"] = [string]$pidResult.value
            $normalized["resolvedOwnerManagedPidFile"] = $managedPidPath
        }
        if ($managedCommandResult.found) {
            $normalized["ownerManagedCommandContains"] = @(Assert-McpCcStringList -Value $managedCommandResult.value -Label "$label ownership.managedCommandContains" -MinimumCount 1 -MaximumCount 8)
        }
        if (-not $commandResult.found -and -not $pidResult.found) {
            throw "$label ownership must declare commandContains or managedPidFile."
        }
    }
    return [pscustomobject]$normalized
}

function ConvertFrom-McpCcComponentDescriptor {
    param(
        [Parameter(Mandatory = $true)]$Descriptor,
        [Parameter(Mandatory = $true)]$RegistryEntry,
        [Parameter(Mandatory = $true)][string]$ResolvedRoot,
        [Parameter(Mandatory = $true)][string]$DescriptorPath
    )
    $componentId = [string]$RegistryEntry.id
    Assert-McpCcObjectShape `
        -Object $Descriptor `
        -Allowed @("schemaVersion", "id", "displayName", "runtimeMode", "runtimeContract", "traits", "contractScript", "capabilities", "lifecycle", "legacyStartup", "timing", "connectivityEvidence", "probes", "navigation", "ui", "safety") `
        -Required @("schemaVersion", "id", "displayName", "runtimeMode", "runtimeContract", "traits", "contractScript", "capabilities", "lifecycle", "probes", "navigation", "safety") `
        -Label "Component descriptor '$componentId'"
    if ($Descriptor.schemaVersion -isnot [int] -and $Descriptor.schemaVersion -isnot [long]) { throw "Component descriptor '$componentId' schemaVersion must be an integer." }
    if ([int]$Descriptor.schemaVersion -ne 1) { throw "Component descriptor '$componentId' has unsupported schemaVersion '$($Descriptor.schemaVersion)'." }
    if (-not ([string]$Descriptor.id).Equals($componentId, [StringComparison]::Ordinal)) {
        throw "Registry id '$componentId' does not match descriptor id '$($Descriptor.id)'."
    }
    if ([string]::IsNullOrWhiteSpace([string]$Descriptor.displayName) -or ([string]$Descriptor.displayName).Length -gt 80) {
        throw "Component descriptor '$componentId' requires displayName of at most 80 characters."
    }
    $runtimeMode = [string]$Descriptor.runtimeMode
    if ($runtimeMode -notin @("legacy-tray", "component-controller")) {
        throw "Component descriptor '$componentId' has unsupported runtimeMode '$runtimeMode'."
    }
    $expectedContract = if ($runtimeMode -eq "legacy-tray") { $script:ExpectedTrayContract } else { $script:ExpectedLifecycleContract }
    if ([string]$Descriptor.runtimeContract -ne $expectedContract) {
        throw "Component descriptor '$componentId' runtimeContract must be '$expectedContract'."
    }
    $traits = @(Assert-McpCcStringList -Value $Descriptor.traits -Label "Component '$componentId' traits" -Allowed $script:ComponentTraits -MaximumCount $script:ComponentTraits.Count)
    $capabilities = @(Assert-McpCcStringList -Value $Descriptor.capabilities -Label "Component '$componentId' capabilities" -Allowed $script:ControllerCapabilities -MinimumCount 1 -MaximumCount $script:ControllerCapabilities.Count)
    if ($runtimeMode -eq "legacy-tray") {
        if ($capabilities.Count -ne 2 -or "ensure_running" -notin $capabilities -or "reload_runtime" -notin $capabilities) {
            throw "Legacy component '$componentId' must declare exactly ensure_running and reload_runtime."
        }
    }
    else {
        $missingBase = @(@("ensure_running", "reload_runtime", "shutdown_runtime") | Where-Object { $_ -notin $capabilities })
        if ($missingBase.Count -gt 0) { throw "Controller component '$componentId' is missing required capability(s): $($missingBase -join ', ')." }
    }

    if ([string]::IsNullOrWhiteSpace([string]$Descriptor.contractScript)) { throw "Component '$componentId' requires contractScript." }
    $resolvedContractScript = Resolve-McpCcChildPath -Root $ResolvedRoot -RelativePath ([string]$Descriptor.contractScript) -Label "contractScript"
    Assert-McpCcObjectShape -Object $Descriptor.lifecycle -Allowed @("ensureLauncher", "reloadLauncher", "controller", "diagnosticLauncher") -Label "Component '$componentId' lifecycle"
    $actions = [ordered]@{}
    if ($runtimeMode -eq "legacy-tray") {
        $ensureResult = Get-McpCcObjectProperty -Object $Descriptor.lifecycle -Name "ensureLauncher"
        $reloadResult = Get-McpCcObjectProperty -Object $Descriptor.lifecycle -Name "reloadLauncher"
        if (-not $ensureResult.found -or -not $reloadResult.found) { throw "Legacy component '$componentId' requires ensureLauncher and reloadLauncher." }
        foreach ($forbidden in @("controller", "diagnosticLauncher")) {
            if ((Get-McpCcObjectProperty -Object $Descriptor.lifecycle -Name $forbidden).found) { throw "Legacy component '$componentId' must not declare lifecycle.$forbidden." }
        }
        $actions["start"] = Assert-McpCcLauncherSpec -Spec $ensureResult.value -Kind "vbs" -ComponentRoot $ResolvedRoot -Label "Component '$componentId' ensureLauncher"
        $actions["restart"] = Assert-McpCcLauncherSpec -Spec $reloadResult.value -Kind "vbs" -ComponentRoot $ResolvedRoot -Label "Component '$componentId' reloadLauncher"
    }
    else {
        $controllerResult = Get-McpCcObjectProperty -Object $Descriptor.lifecycle -Name "controller"
        if (-not $controllerResult.found) { throw "Controller component '$componentId' requires lifecycle.controller." }
        foreach ($forbidden in @("ensureLauncher", "reloadLauncher")) {
            if ((Get-McpCcObjectProperty -Object $Descriptor.lifecycle -Name $forbidden).found) { throw "Controller component '$componentId' must not declare lifecycle.$forbidden." }
        }
        $controller = Assert-McpCcLauncherSpec -Spec $controllerResult.value -Kind "powershell" -ComponentRoot $ResolvedRoot -Label "Component '$componentId' controller"
        $diagnosticResult = Get-McpCcObjectProperty -Object $Descriptor.lifecycle -Name "diagnosticLauncher"
        $diagnostic = $null
        if ($diagnosticResult.found) {
            $diagnostic = Assert-McpCcLauncherSpec -Spec $diagnosticResult.value -Kind "vbs" -ComponentRoot $ResolvedRoot -Label "Component '$componentId' diagnosticLauncher"
        }
        foreach ($capability in $capabilities) {
            if ($capability -eq "show_diagnostic_tray") {
                if ($null -eq $diagnostic) { throw "Component '$componentId' declares show_diagnostic_tray without diagnosticLauncher." }
                $actions[$capability] = $diagnostic
            }
            else { $actions[$capability] = $controller }
        }
        if ($null -ne $diagnostic -and "show_diagnostic_tray" -notin $capabilities) {
            throw "Component '$componentId' diagnosticLauncher requires show_diagnostic_tray capability."
        }
    }

    $timing = [pscustomobject]@{}
    $timingResult = Get-McpCcObjectProperty -Object $Descriptor -Name "timing"
    if ($timingResult.found) {
        Assert-McpCcObjectShape -Object $timingResult.value -Allowed @("postStartTimeoutSeconds", "controllerActionTimeoutSeconds") -Label "Component '$componentId' timing"
        $postStartResult = Get-McpCcObjectProperty -Object $timingResult.value -Name "postStartTimeoutSeconds"
        $controllerTimeoutResult = Get-McpCcObjectProperty -Object $timingResult.value -Name "controllerActionTimeoutSeconds"
        $timingHash = [ordered]@{}
        if ($postStartResult.found) { $timingHash["postStartTimeoutSeconds"] = Assert-McpCcIntegerRange -Value $postStartResult.value -Label "Component '$componentId' postStartTimeoutSeconds" -Minimum 5 -Maximum 300 }
        if ($controllerTimeoutResult.found) { $timingHash["controllerActionTimeoutSeconds"] = Assert-McpCcIntegerRange -Value $controllerTimeoutResult.value -Label "Component '$componentId' controllerActionTimeoutSeconds" -Minimum 5 -Maximum 300 }
        $timing = [pscustomobject]$timingHash
    }

    $connectivityEvidence = [pscustomobject]@{}
    $connectivityEvidenceResult = Get-McpCcObjectProperty -Object $Descriptor -Name "connectivityEvidence"
    if ($connectivityEvidenceResult.found) {
        Assert-McpCcObjectShape `
            -Object $connectivityEvidenceResult.value `
            -Allowed @("remoteEvidencePath") `
            -Required @("remoteEvidencePath") `
            -Label "Component '$componentId' connectivityEvidence"
        $remoteEvidencePath = [string]$connectivityEvidenceResult.value.remoteEvidencePath
        if ([string]::IsNullOrWhiteSpace($remoteEvidencePath) -or -not $remoteEvidencePath.EndsWith(".json", [StringComparison]::OrdinalIgnoreCase)) {
            throw "Component '$componentId' connectivityEvidence.remoteEvidencePath must be a JSON file."
        }
        $resolvedRemoteEvidencePath = Resolve-McpCcChildPath `
            -Root $ResolvedRoot `
            -RelativePath $remoteEvidencePath `
            -Label "Component '$componentId' remote connectivity evidence"
        $connectivityEvidence = [pscustomobject]@{
            remoteEvidencePath = $remoteEvidencePath
            resolvedRemoteEvidencePath = $resolvedRemoteEvidencePath
        }
    }

    if ($null -eq $Descriptor.probes -or $Descriptor.probes -is [string]) { throw "Component '$componentId' probes must be an array." }
    $probeDocuments = @($Descriptor.probes)
    if ($probeDocuments.Count -lt 1 -or $probeDocuments.Count -gt 16) { throw "Component '$componentId' requires between 1 and 16 probes." }
    $probeIds = @{}
    $probes = @()
    foreach ($probeDocument in $probeDocuments) {
        $probe = ConvertFrom-McpCcDescriptorProbe -Probe $probeDocument -ComponentId $componentId -ComponentRoot $ResolvedRoot
        if ($probeIds.ContainsKey([string]$probe.id)) { throw "Component '$componentId' has duplicate probe id '$($probe.id)'." }
        $probeIds[[string]$probe.id] = $true
        $probes += $probe
    }
    if (@($probes | Where-Object { $_.required -and $_.role -eq "core" }).Count -eq 0) {
        throw "Component '$componentId' requires at least one required core probe."
    }
    if ("tunnel" -in $traits) {
        if (@($probes | Where-Object { $_.required -and $_.role -eq "connectivity" }).Count -eq 0) { throw "Component '$componentId' tunnel trait requires a required connectivity probe." }
        if ($runtimeMode -eq "component-controller" -and "repair_connectivity" -notin $capabilities) { throw "Controller component '$componentId' tunnel trait requires repair_connectivity." }
    }
    if ("external-dependency" -in $traits -and @($probes | Where-Object { $_.role -eq "dependency" }).Count -eq 0) {
        throw "Component '$componentId' external-dependency trait requires a dependency probe."
    }
    foreach ($role in @("core", "connectivity")) {
        $roleProbes = @($probes | Where-Object { $_.required -and $_.role -eq $role })
        if ($roleProbes.Count -gt 0 -and @($roleProbes | Where-Object { @($_.ownerCommandContains).Count -gt 0 -or -not [string]::IsNullOrWhiteSpace([string]$_.ownerManagedPidFile) }).Count -eq 0) {
            throw "Component '$componentId' required $role probes need ownership evidence."
        }
    }

    if ($null -eq $Descriptor.navigation -or $Descriptor.navigation -is [string]) { throw "Component '$componentId' navigation must be an array." }
    $navigationDocuments = @($Descriptor.navigation)
    if ($navigationDocuments.Count -gt 16) { throw "Component '$componentId' navigation exceeds 16 entries." }
    $navigationIds = @{}
    $navigation = @()
    foreach ($item in $navigationDocuments) {
        Assert-McpCcObjectShape -Object $item -Allowed @("id", "label", "kind", "target") -Required @("id", "label", "kind", "target") -Label "Component '$componentId' navigation item"
        $navigationId = [string]$item.id
        if ([string]::IsNullOrWhiteSpace($navigationId) -or $navigationId -notmatch '^[a-z][a-z0-9_]{0,63}$' -or $navigationIds.ContainsKey($navigationId)) {
            throw "Component '$componentId' has invalid or duplicate navigation id '$navigationId'."
        }
        $navigationIds[$navigationId] = $true
        if ([string]::IsNullOrWhiteSpace([string]$item.label) -or ([string]$item.label).Length -gt 80) { throw "Component '$componentId' navigation '$navigationId' has an invalid label." }
        $kind = [string]$item.kind
        $target = [string]$item.target
        if ($kind -eq "probe") {
            if (-not $probeIds.ContainsKey($target)) { throw "Component '$componentId' navigation '$navigationId' references unknown probe '$target'." }
        }
        elseif ($kind -eq "component-path") {
            $resolvedNavigationPath = Resolve-McpCcChildPath -Root $ResolvedRoot -RelativePath $target -Label "Component '$componentId' navigation '$navigationId'"
            if (-not (Test-Path -LiteralPath $resolvedNavigationPath)) { throw "Component '$componentId' navigation '$navigationId' path does not exist." }
        }
        elseif ($kind -eq "loopback-url") { Assert-McpCcLoopbackUrl -Url $target }
        else { throw "Component '$componentId' navigation '$navigationId' has unsupported kind '$kind'." }
        $navigation += [pscustomobject]@{ id = $navigationId; label = [string]$item.label; kind = $kind; target = $target }
    }

    $uiHash = [ordered]@{}
    $uiResult = Get-McpCcObjectProperty -Object $Descriptor -Name "ui"
    if ($uiResult.found) {
        Assert-McpCcObjectShape -Object $uiResult.value -Allowed @("primaryLauncher", "menuContract", "actionEntrypoint", "menuActions") -Label "Component '$componentId' ui"
        $primaryLauncherResult = Get-McpCcObjectProperty -Object $uiResult.value -Name "primaryLauncher"
        if ($primaryLauncherResult.found) {
            $uiHash["primaryLauncher"] = Assert-McpCcLauncherSpec -Spec $primaryLauncherResult.value -Kind "vbs" -ComponentRoot $ResolvedRoot -Label "Component '$componentId' primaryLauncher"
        }
        $menuContractResult = Get-McpCcObjectProperty -Object $uiResult.value -Name "menuContract"
        $actionEntrypointResult = Get-McpCcObjectProperty -Object $uiResult.value -Name "actionEntrypoint"
        $menuActionsResult = Get-McpCcObjectProperty -Object $uiResult.value -Name "menuActions"
        $menuFieldCount = @(@($menuContractResult, $actionEntrypointResult, $menuActionsResult) | Where-Object { $_.found }).Count
        if ($menuFieldCount -gt 0 -and $menuFieldCount -ne 3) {
            throw "Component '$componentId' ui menu requires menuContract, actionEntrypoint, and menuActions together."
        }
        if ($menuFieldCount -eq 3) {
            if ($runtimeMode -ne "component-controller") { throw "Component '$componentId' component menu requires component-controller mode." }
            if ([string]$menuContractResult.value -ne $script:ExpectedComponentMenuContract) {
                throw "Component '$componentId' ui.menuContract must be '$script:ExpectedComponentMenuContract'."
            }
            $actionEntrypoint = Assert-McpCcLauncherSpec -Spec $actionEntrypointResult.value -Kind "powershell" -ComponentRoot $ResolvedRoot -Label "Component '$componentId' UI action entrypoint"
            if ($menuActionsResult.value -is [string]) { throw "Component '$componentId' ui.menuActions must be an array." }
            $menuActionDocuments = @($menuActionsResult.value)
            if ($menuActionDocuments.Count -lt 1 -or $menuActionDocuments.Count -gt 24) {
                throw "Component '$componentId' ui.menuActions requires between 1 and 24 entries."
            }
            $menuActionIds = @{}
            $menuActions = @()
            foreach ($menuAction in $menuActionDocuments) {
                Assert-McpCcObjectShape -Object $menuAction -Allowed @("id", "label", "group", "confirmation") -Required @("id", "label", "group", "confirmation") -Label "Component '$componentId' UI menu action"
                $menuActionId = [string]$menuAction.id
                if ([string]::IsNullOrWhiteSpace($menuActionId) -or $menuActionId -notmatch '^[a-z][a-z0-9_]{0,63}$' -or $menuActionIds.ContainsKey($menuActionId)) {
                    throw "Component '$componentId' has invalid or duplicate UI menu action id '$menuActionId'."
                }
                if ([string]::IsNullOrWhiteSpace([string]$menuAction.label) -or ([string]$menuAction.label).Length -gt 80) {
                    throw "Component '$componentId' UI menu action '$menuActionId' has an invalid label."
                }
                $menuActionGroup = [string]$menuAction.group
                if ($menuActionGroup -notin @("connection", "component")) {
                    throw "Component '$componentId' UI menu action '$menuActionId' has unsupported group '$menuActionGroup'."
                }
                $menuActionConfirmation = [string]$menuAction.confirmation
                if ($menuActionConfirmation -notin @("none", "required")) {
                    throw "Component '$componentId' UI menu action '$menuActionId' has unsupported confirmation '$menuActionConfirmation'."
                }
                $menuActionIds[$menuActionId] = $true
                $menuActions += [pscustomobject]@{
                    id = $menuActionId
                    label = [string]$menuAction.label
                    group = $menuActionGroup
                    confirmation = $menuActionConfirmation
                }
            }
            $uiHash["menuContract"] = $script:ExpectedComponentMenuContract
            $uiHash["actionEntrypoint"] = $actionEntrypoint
            $uiHash["menuActions"] = $menuActions
        }
    }
    $primaryNavigationCount = @($navigation | Where-Object { $_.id -eq "primary_ui" -and $_.kind -eq "loopback-url" }).Count
    $primaryLauncherCount = if ($uiHash.Contains("primaryLauncher")) { 1 } else { 0 }
    if ("primary-ui" -in $traits) {
        if (($primaryNavigationCount + $primaryLauncherCount) -ne 1) { throw "Component '$componentId' primary-ui trait requires exactly one primary UI target." }
    }
    elseif (($primaryNavigationCount + $primaryLauncherCount) -gt 0) { throw "Component '$componentId' primary UI target requires primary-ui trait." }
    if ($runtimeMode -eq "component-controller") {
        if ("diagnostic-ui" -in $traits -and "show_diagnostic_tray" -notin $capabilities) {
            throw "Controller component '$componentId' diagnostic-ui trait requires show_diagnostic_tray."
        }
        if ("show_diagnostic_tray" -in $capabilities -and "diagnostic-ui" -notin $traits) {
            throw "Controller component '$componentId' show_diagnostic_tray capability requires diagnostic-ui trait."
        }
    }

    Assert-McpCcObjectShape -Object $Descriptor.safety -Allowed @("managerDomainDataAccess", "managerSecretAccess", "shutdownConfirmation") -Required @("managerDomainDataAccess", "managerSecretAccess", "shutdownConfirmation") -Label "Component '$componentId' safety"
    if ([string]$Descriptor.safety.managerDomainDataAccess -ne "none" -or [string]$Descriptor.safety.managerSecretAccess -ne "none" -or [string]$Descriptor.safety.shutdownConfirmation -ne "required") {
        throw "Component '$componentId' safety contract must deny manager domain/secret access and require shutdown confirmation."
    }

    $legacyStartup = $null
    $legacyStartupResult = Get-McpCcObjectProperty -Object $Descriptor -Name "legacyStartup"
    if ($legacyStartupResult.found) {
        Assert-McpCcObjectShape -Object $legacyStartupResult.value -Allowed @("shortcutName", "launcher") -Required @("shortcutName", "launcher") -Label "Component '$componentId' legacyStartup"
        if (-not ([string]$legacyStartupResult.value.shortcutName).EndsWith(".lnk", [StringComparison]::OrdinalIgnoreCase)) { throw "Component '$componentId' legacy shortcut must end in .lnk." }
        $null = Resolve-McpCcChildPath -Root $ResolvedRoot -RelativePath ([string]$legacyStartupResult.value.launcher) -Label "Component '$componentId' legacy startup launcher"
        $legacyStartup = [pscustomobject]@{ shortcutName = [string]$legacyStartupResult.value.shortcutName; launcher = [string]$legacyStartupResult.value.launcher }
    }

    return [pscustomobject]@{
        id = $componentId
        displayName = [string]$Descriptor.displayName
        root = [string]$RegistryEntry.root
        resolvedRoot = $ResolvedRoot
        descriptorPath = $DescriptorPath
        descriptorSchemaVersion = 1
        runtimeMode = $runtimeMode
        runtimeContract = $expectedContract
        contractScript = [string]$Descriptor.contractScript
        resolvedContractScript = $resolvedContractScript
        enabled = [bool]$RegistryEntry.enabled
        autoStart = [bool]$RegistryEntry.autoStart
        startupOrder = [int]$RegistryEntry.startupOrder
        traits = $traits
        capabilities = $capabilities
        actions = [pscustomobject]$actions
        legacyStartup = $legacyStartup
        timing = $timing
        connectivityEvidence = $connectivityEvidence
        probes = $probes
        navigation = $navigation
        ui = [pscustomobject]$uiHash
        safety = [pscustomobject]@{
            managerDomainDataAccess = "none"
            managerSecretAccess = "none"
            shutdownConfirmation = "required"
        }
    }
}

function Read-McpCcComponentCandidate {
    param(
        [Parameter(Mandatory = $true)][string]$ComponentRoot,
        [string]$WorkspaceRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
        [ValidateRange(0, 10000)][int]$StartupOrder = 0
    )
    $resolvedWorkspace = (Resolve-Path -LiteralPath $WorkspaceRoot -ErrorAction Stop).Path
    $resolvedRoot = (Resolve-Path -LiteralPath $ComponentRoot -ErrorAction Stop).Path
    if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) {
        throw "Component candidate root does not exist: $resolvedRoot"
    }
    $resolvedParent = Split-Path -Parent $resolvedRoot
    if (-not $resolvedParent.Equals($resolvedWorkspace, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Component candidate root must be a direct child of the workspace root."
    }
    $rootItem = Get-Item -LiteralPath $resolvedRoot -Force -ErrorAction Stop
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Component candidate root must not be a reparse point."
    }
    $descriptorPath = Join-Path $resolvedRoot "control-center\component.json"
    $descriptorRead = Read-McpCcJsonFile -Path $descriptorPath -Label "component candidate descriptor"
    $idResult = Get-McpCcObjectProperty -Object $descriptorRead.document -Name "id"
    if (-not $idResult.found -or [string]::IsNullOrWhiteSpace([string]$idResult.value)) {
        throw "Component candidate descriptor requires id."
    }
    $entry = [pscustomobject]@{
        id = [string]$idResult.value
        root = Split-Path -Leaf $resolvedRoot
        descriptor = "control-center\component.json"
        enabled = $false
        autoStart = $false
        startupOrder = $StartupOrder
    }
    return ConvertFrom-McpCcComponentDescriptor `
        -Descriptor $descriptorRead.document `
        -RegistryEntry $entry `
        -ResolvedRoot $resolvedRoot `
        -DescriptorPath $descriptorRead.path
}

function Read-McpCcRegistryManifest {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Registry
    )
    Assert-McpCcObjectShape -Object $Registry -Allowed @("schemaVersion", "settings", "components") -Required @("schemaVersion", "settings", "components") -Label "Registry v3"
    if ($Registry.schemaVersion -isnot [int] -and $Registry.schemaVersion -isnot [long]) { throw "Registry schemaVersion must be an integer." }
    if ([int]$Registry.schemaVersion -ne 3) { throw "Unsupported registry schemaVersion '$($Registry.schemaVersion)'." }
    Assert-McpCcObjectShape `
        -Object $Registry.settings `
        -Allowed @("initialDelaySeconds", "betweenComponentsSeconds", "probeTimeoutSeconds", "postStartTimeoutSeconds", "controllerActionTimeoutSeconds", "refreshIntervalSeconds", "eventRetentionDays") `
        -Required @("initialDelaySeconds", "betweenComponentsSeconds", "probeTimeoutSeconds", "postStartTimeoutSeconds", "controllerActionTimeoutSeconds", "refreshIntervalSeconds", "eventRetentionDays") `
        -Label "Registry settings"
    foreach ($setting in @(
        @{ Name = "initialDelaySeconds"; Min = 0; Max = 300 },
        @{ Name = "betweenComponentsSeconds"; Min = 0; Max = 60 },
        @{ Name = "probeTimeoutSeconds"; Min = 1; Max = 15 },
        @{ Name = "postStartTimeoutSeconds"; Min = 5; Max = 300 },
        @{ Name = "controllerActionTimeoutSeconds"; Min = 5; Max = 300 },
        @{ Name = "refreshIntervalSeconds"; Min = 10; Max = 3600 },
        @{ Name = "eventRetentionDays"; Min = 1; Max = 365 }
    )) {
        $settingName = [string]$setting.Name
        $settingProperty = $Registry.settings.PSObject.Properties[$settingName]
        $settingProperty.Value = Assert-McpCcIntegerRange -Value $settingProperty.Value -Label "Registry setting '$settingName'" -Minimum $setting.Min -Maximum $setting.Max
    }
    if ($null -eq $Registry.components -or $Registry.components -is [string]) { throw "Registry components must be an array." }
    $entries = @($Registry.components)
    if ($entries.Count -lt 1 -or $entries.Count -gt $script:MaximumRegistryComponents) {
        throw "Registry must contain between 1 and $script:MaximumRegistryComponents components."
    }

    $manifestPath = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    $manifestDirectory = Split-Path -Parent $manifestPath
    $managerRoot = Split-Path -Parent $manifestDirectory
    $workspaceRoot = Split-Path -Parent $managerRoot
    $ids = @{}
    $roots = @{}
    $orders = @{}
    $ownedPorts = @{}
    $registeredEntries = @()
    $registeredComponents = @()
    $activeComponents = @()
    foreach ($entry in $entries) {
        Assert-McpCcObjectShape -Object $entry -Allowed @("id", "root", "descriptor", "enabled", "autoStart", "startupOrder") -Required @("id", "root", "descriptor", "enabled", "autoStart", "startupOrder") -Label "Registry component entry"
        $id = [string]$entry.id
        if ([string]::IsNullOrWhiteSpace($id) -or $id -notmatch '^[a-z][a-z0-9_]{0,63}$') { throw "Every registry component requires a stable lowercase id." }
        if ($ids.ContainsKey($id)) { throw "Duplicate component id '$id'." }
        $ids[$id] = $true
        if ([IO.Path]::IsPathRooted([string]$entry.root) -or [string]::IsNullOrWhiteSpace([string]$entry.root)) { throw "Component '$id' root must be relative." }
        $resolvedRoot = [IO.Path]::GetFullPath((Join-Path $manifestDirectory ([string]$entry.root)))
        $resolvedParent = Split-Path -Parent $resolvedRoot
        if (-not $resolvedParent.Equals($workspaceRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "Component '$id' root must be a direct child of the workspace root." }
        if ($roots.ContainsKey($resolvedRoot)) { throw "Duplicate component root '$resolvedRoot'." }
        $roots[$resolvedRoot] = $true
        if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) { throw "Component '$id' root does not exist." }
        if (-not ([string]$entry.descriptor).Equals("control-center\component.json", [StringComparison]::OrdinalIgnoreCase)) { throw "Component '$id' descriptor must be 'control-center\component.json'." }
        Assert-McpCcBoolean -Value $entry.enabled -Label "Component '$id' enabled"
        Assert-McpCcBoolean -Value $entry.autoStart -Label "Component '$id' autoStart"
        if (-not [bool]$entry.enabled -and [bool]$entry.autoStart) { throw "Disabled component '$id' must set autoStart=false." }
        $startupOrder = Assert-McpCcIntegerRange -Value $entry.startupOrder -Label "Component '$id' startupOrder" -Minimum 0 -Maximum 10000
        if ($orders.ContainsKey($startupOrder)) { throw "Duplicate startupOrder '$startupOrder'." }
        $orders[$startupOrder] = $true
        $descriptorPath = Resolve-McpCcChildPath -Root $resolvedRoot -RelativePath ([string]$entry.descriptor) -Label "Component '$id' descriptor"
        $descriptorRead = Read-McpCcJsonFile -Path $descriptorPath -Label "component descriptor '$id'"
        $component = ConvertFrom-McpCcComponentDescriptor -Descriptor $descriptorRead.document -RegistryEntry $entry -ResolvedRoot $resolvedRoot -DescriptorPath $descriptorRead.path
        foreach ($probe in @($component.probes | Where-Object { $_.role -in @("core", "connectivity") })) {
            $portKey = [string][int]$probe.port
            if ($ownedPorts.ContainsKey($portKey)) {
                $existingOwner = $ownedPorts[$portKey]
                if (-not ([string]$existingOwner.componentId).Equals($id, [StringComparison]::OrdinalIgnoreCase)) {
                    throw "Owned port '$portKey' is duplicated by '$id/$($probe.id)' and '$($existingOwner.label)'."
                }
                continue
            }
            $ownedPorts[$portKey] = [pscustomobject]@{ componentId = $id; label = "$id/$($probe.id)" }
        }
        $registeredEntries += [pscustomobject]@{
            id = $id
            root = [string]$entry.root
            resolvedRoot = $resolvedRoot
            descriptor = [string]$entry.descriptor
            descriptorPath = $descriptorRead.path
            enabled = [bool]$entry.enabled
            autoStart = [bool]$entry.autoStart
            startupOrder = $startupOrder
        }
        $registeredComponents += $component
        if ([bool]$entry.enabled) { $activeComponents += $component }
    }
    if ($activeComponents.Count -eq 0) { throw "Registry requires at least one enabled component." }
    return [pscustomobject]@{
        schemaVersion = 3
        settings = $Registry.settings
        components = $activeComponents
        registryEntries = $registeredEntries
        registeredComponents = $registeredComponents
        registeredCount = $registeredEntries.Count
        enabledCount = $activeComponents.Count
        sourcePath = $manifestPath
        managerRoot = $managerRoot
        workspaceRoot = $workspaceRoot
    }
}

function Read-McpCcManifest {
    param([string]$Path = (Get-McpCcDefaultManifestPath))
    $read = Read-McpCcJsonFile -Path $Path -Label "control-center manifest"
    Assert-McpCcObjectShape -Object $read.document -Allowed @($read.document.PSObject.Properties.Name) -Required @("schemaVersion") -Label "Control-center manifest"
    if ($read.document.schemaVersion -isnot [int] -and $read.document.schemaVersion -isnot [long]) { throw "Manifest schemaVersion must be an integer." }
    $schemaVersion = [int]$read.document.schemaVersion
    if ($schemaVersion -in @(1, 2)) { return Read-McpCcLegacyManifest -Path $read.path }
    if ($schemaVersion -eq 3) { return Read-McpCcRegistryManifest -Path $read.path -Registry $read.document }
    throw "Unsupported manifest schemaVersion '$schemaVersion'."
}

function Get-McpCcComponent {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string]$Id
    )
    $match = @($Manifest.components | Where-Object { $_.id -eq $Id })
    if ($match.Count -ne 1) {
        throw "Unknown component '$Id'."
    }
    return $match[0]
}

function Test-McpCcTcpPort {
    param([Parameter(Mandatory = $true)][int]$Port, [int]$TimeoutMilliseconds = 300)
    $client = New-Object Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMilliseconds, $false)) {
            return $false
        }
        $client.EndConnect($async)
        return $true
    }
    catch { return $false }
    finally { $client.Dispose() }
}

function ConvertFrom-McpCcDynamicPortRangeText {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)

    $values = @()
    foreach ($line in @($Text -split "`r?`n")) {
        if ([string]$line -match ':\s*(\d+)\s*$') {
            $values += [int]$matches[1]
        }
    }
    if ($values.Count -lt 2) {
        throw "Windows dynamic TCP port range output is invalid."
    }
    $start = [int]$values[0]
    $count = [int]$values[1]
    $end = $start + $count - 1
    if ($start -lt 1 -or $count -lt 1 -or $end -gt 65535) {
        throw "Windows dynamic TCP port range is outside the valid TCP port space."
    }
    return [pscustomobject]@{
        start = $start
        end = $end
        count = $count
    }
}

function ConvertFrom-McpCcExcludedPortRangeText {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)

    $ranges = @()
    foreach ($line in @($Text -split "`r?`n")) {
        if ([string]$line -match '^\s*(\d+)\s+(\d+)(?:\s+(\*))?\s*$') {
            $start = [int]$matches[1]
            $end = [int]$matches[2]
            if ($start -lt 1 -or $end -lt $start -or $end -gt 65535) {
                throw "Windows excluded TCP port range is outside the valid TCP port space."
            }
            $ranges += [pscustomobject]@{
                start = $start
                end = $end
                administered = -not [string]::IsNullOrWhiteSpace([string]$matches[3])
            }
        }
    }
    return [object[]]$ranges
}

function Get-McpCcWindowsTcpPortPolicy {
    param([scriptblock]$CommandRunner)

    if ($null -eq $CommandRunner) {
        $netshPath = Join-Path $env:WINDIR "System32\netsh.exe"
        $CommandRunner = {
            param([string[]]$Arguments)
            $output = @(& $netshPath @Arguments 2>&1)
            if ($LASTEXITCODE -ne 0) {
                throw "netsh exited with code $LASTEXITCODE."
            }
            return $output
        }.GetNewClosure()
    }

    $families = [ordered]@{}
    foreach ($family in @("ipv4", "ipv6")) {
        try {
            $dynamicText = (@(& $CommandRunner ([string[]]@("interface", $family, "show", "dynamicportrange", "protocol=tcp"))) -join "`n")
            $excludedText = (@(& $CommandRunner ([string[]]@("interface", $family, "show", "excludedportrange", "protocol=tcp"))) -join "`n")
            $families[$family] = [pscustomobject]@{
                available = $true
                errorCode = $null
                dynamicRange = ConvertFrom-McpCcDynamicPortRangeText -Text $dynamicText
                excludedRanges = @(ConvertFrom-McpCcExcludedPortRangeText -Text $excludedText)
            }
        }
        catch {
            $families[$family] = [pscustomobject]@{
                available = $false
                errorCode = "PORT_POLICY_UNAVAILABLE"
                dynamicRange = $null
                excludedRanges = @()
            }
        }
    }
    $availableCount = @($families.Values | Where-Object { $_.available }).Count
    return [pscustomobject]@{
        contractVersion = "windows-tcp-port-policy-v1"
        available = $availableCount -eq 2
        errorCode = if ($availableCount -eq 2) { $null } elseif ($availableCount -eq 1) { "PORT_POLICY_PARTIAL" } else { "PORT_POLICY_UNAVAILABLE" }
        ipv4 = $families.ipv4
        ipv6 = $families.ipv6
    }
}

function Test-McpCcPortAgainstPolicy {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$HostName,
        $Policy
    )

    $familyNames = @(
        if ($HostName -eq "::1" -or $HostName -eq "[::1]") {
            "ipv6"
        }
        elseif ($HostName.Equals("localhost", [StringComparison]::OrdinalIgnoreCase)) {
            "ipv4"
            "ipv6"
        }
        else {
            "ipv4"
        }
    )
    $checkedFamilies = @()
    if ($null -eq $Policy) {
        return [pscustomobject]@{ known = $false; safe = $null; errorCode = $null; families = $checkedFamilies }
    }
    foreach ($familyName in $familyNames) {
        $familyResult = Get-McpCcObjectProperty -Object $Policy -Name $familyName
        if (-not $familyResult.found -or $null -eq $familyResult.value -or -not [bool]$familyResult.value.available) {
            continue
        }
        $checkedFamilies += $familyName
        foreach ($range in @($familyResult.value.excludedRanges)) {
            if ($Port -ge [int]$range.start -and $Port -le [int]$range.end) {
                return [pscustomobject]@{ known = $true; safe = $false; errorCode = "PORT_EXCLUDED"; families = $checkedFamilies }
            }
        }
        $dynamicRange = $familyResult.value.dynamicRange
        if ($null -ne $dynamicRange -and $Port -ge [int]$dynamicRange.start -and $Port -le [int]$dynamicRange.end) {
            return [pscustomobject]@{ known = $true; safe = $false; errorCode = "PORT_IN_DYNAMIC_RANGE"; families = $checkedFamilies }
        }
    }
    if ($checkedFamilies.Count -lt $familyNames.Count) {
        $policyErrorCode = if ($checkedFamilies.Count -eq 0) { "PORT_POLICY_UNAVAILABLE" } else { "PORT_POLICY_PARTIAL" }
        return [pscustomobject]@{ known = $false; safe = $null; errorCode = $policyErrorCode; families = $checkedFamilies }
    }
    return [pscustomobject]@{ known = $true; safe = $true; errorCode = $null; families = $checkedFamilies }
}

function ConvertTo-McpCcPortPolicySummary {
    param($Policy)

    if ($null -eq $Policy) { return $null }
    $familySummaries = [ordered]@{}
    foreach ($familyName in @("ipv4", "ipv6")) {
        $familyResult = Get-McpCcObjectProperty -Object $Policy -Name $familyName
        $family = if ($familyResult.found) { $familyResult.value } else { $null }
        $dynamicRange = if ($null -ne $family) { $family.dynamicRange } else { $null }
        $familySummaries[$familyName] = [pscustomobject]@{
            available = $null -ne $family -and [bool]$family.available
            errorCode = if ($null -eq $family) { "PORT_POLICY_UNAVAILABLE" } elseif ([string]::IsNullOrWhiteSpace([string]$family.errorCode)) { $null } else { [string]$family.errorCode }
            dynamicStart = if ($null -eq $dynamicRange) { $null } else { [int]$dynamicRange.start }
            dynamicEnd = if ($null -eq $dynamicRange) { $null } else { [int]$dynamicRange.end }
            excludedRangeCount = if ($null -eq $family) { 0 } else { @($family.excludedRanges).Count }
        }
    }
    return [pscustomobject]@{
        contractVersion = "windows-tcp-port-policy-v1"
        available = [bool]$Policy.available
        errorCode = if ([string]::IsNullOrWhiteSpace([string]$Policy.errorCode)) { $null } else { [string]$Policy.errorCode }
        ipv4 = $familySummaries.ipv4
        ipv6 = $familySummaries.ipv6
    }
}

function Test-McpCcCommandLineContains {
    param(
        [AllowNull()][string]$CommandLine,
        [string[]]$ExpectedFragments = @()
    )
    foreach ($fragment in @($ExpectedFragments)) {
        if ([string]::IsNullOrWhiteSpace($fragment)) { continue }
        if ([string]::IsNullOrWhiteSpace($CommandLine) -or $CommandLine -notlike "*$fragment*") {
            return $false
        }
    }
    return $true
}

function Get-McpCcProcessLineage {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][int]$ExpectedAncestorProcessId,
        [scriptblock]$ProcessLookup
    )
    if ($ProcessId -le 0 -or $ExpectedAncestorProcessId -le 0) {
        return [pscustomobject]@{ known = $true; matches = $false; depth = $null }
    }
    if ($ProcessId -eq $ExpectedAncestorProcessId) {
        return [pscustomobject]@{ known = $true; matches = $true; depth = 0 }
    }
    if ($null -eq $ProcessLookup) {
        $ProcessLookup = {
            param([int]$LookupProcessId)
            Get-CimInstance Win32_Process -Filter "ProcessId=$LookupProcessId" -ErrorAction Stop
        }
    }

    $visited = @{}
    $currentProcessId = $ProcessId
    for ($depth = 0; $depth -lt 32; $depth++) {
        if ($visited.ContainsKey($currentProcessId)) {
            return [pscustomobject]@{ known = $true; matches = $false; depth = $null }
        }
        $visited[$currentProcessId] = $true
        try {
            $process = & $ProcessLookup $currentProcessId
        }
        catch {
            return [pscustomobject]@{ known = $false; matches = $null; depth = $null }
        }
        if ($null -eq $process) {
            return [pscustomobject]@{ known = $false; matches = $null; depth = $null }
        }
        $parentProcessId = [int]$process.ParentProcessId
        if ($parentProcessId -eq $ExpectedAncestorProcessId) {
            return [pscustomobject]@{ known = $true; matches = $true; depth = ($depth + 1) }
        }
        if ($parentProcessId -le 0 -or $parentProcessId -eq $currentProcessId) {
            return [pscustomobject]@{ known = $true; matches = $false; depth = $null }
        }
        $currentProcessId = $parentProcessId
    }
    return [pscustomobject]@{ known = $true; matches = $false; depth = $null }
}

function Get-McpCcPortOwner {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [string[]]$ExpectedCommandFragments = @(),
        [string]$ManagedPidPath,
        [string[]]$ManagedExpectedCommandFragments = @()
    )
    try {
        $ownerProcessId = $null
        try {
            $connection = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop | Select-Object -First 1
            if ($null -ne $connection) { $ownerProcessId = [int]$connection.OwningProcess }
        }
        catch { }
        if ($null -eq $ownerProcessId) {
            $netstatPath = Join-Path $env:WINDIR "System32\netstat.exe"
            if (Test-Path -LiteralPath $netstatPath -PathType Leaf) {
                foreach ($line in @(& $netstatPath -ano -p TCP 2>$null)) {
                    if ([string]$line -match ("^\s*TCP\s+\S+:" + $Port + "\s+\S+\s+LISTENING\s+(\d+)\s*$")) {
                        $ownerProcessId = [int]$matches[1]
                        break
                    }
                }
            }
        }
        if ($null -eq $ownerProcessId) {
            return [pscustomobject]@{
                known = $false; pid = $null; processName = $null; matchesExpected = $null
                managedPid = $null; managedProcessName = $null; relation = $null
            }
        }
        try {
            $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerProcessId" -ErrorAction Stop
        }
        catch {
            return [pscustomobject]@{
                known = $true; pid = [int]$ownerProcessId; processName = $null; matchesExpected = $null
                managedPid = $null; managedProcessName = $null; relation = "Unknown"
            }
        }

        $ownershipConfigured = @($ExpectedCommandFragments).Count -gt 0 -or -not [string]::IsNullOrWhiteSpace($ManagedPidPath)
        $matches = Test-McpCcCommandLineContains `
            -CommandLine ([string]$process.CommandLine) `
            -ExpectedFragments $ExpectedCommandFragments
        $managedPid = $null
        $managedProcess = $null
        $relation = $null

        if (-not [string]::IsNullOrWhiteSpace($ManagedPidPath)) {
            if (-not (Test-Path -LiteralPath $ManagedPidPath -PathType Leaf)) {
                $matches = $false
                $relation = "MissingPidFile"
            }
            else {
                $managedPidText = (Get-Content -LiteralPath $ManagedPidPath -Encoding UTF8 -Raw).Trim()
                $parsedManagedPid = 0
                if (-not [int]::TryParse($managedPidText, [ref]$parsedManagedPid) -or $parsedManagedPid -le 0) {
                    $matches = $false
                    $relation = "InvalidPidFile"
                }
                else {
                    $managedPid = $parsedManagedPid
                    try {
                        $managedProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$managedPid" -ErrorAction Stop
                    }
                    catch {
                        return [pscustomobject]@{
                            known = $true
                            pid = [int]$ownerProcessId
                            processName = [string]$process.Name
                            matchesExpected = $null
                            managedPid = $managedPid
                            managedProcessName = $null
                            relation = "Unknown"
                        }
                    }
                    if ($null -eq $managedProcess) {
                        $matches = $false
                        $relation = "ManagedProcessMissing"
                    }
                    else {
                        $managedMatches = Test-McpCcCommandLineContains `
                            -CommandLine ([string]$managedProcess.CommandLine) `
                            -ExpectedFragments $ManagedExpectedCommandFragments
                        $lineage = Get-McpCcProcessLineage `
                            -ProcessId ([int]$ownerProcessId) `
                            -ExpectedAncestorProcessId $managedPid
                        if (-not $lineage.known) {
                            return [pscustomobject]@{
                                known = $true
                                pid = [int]$ownerProcessId
                                processName = [string]$process.Name
                                matchesExpected = $null
                                managedPid = $managedPid
                                managedProcessName = [string]$managedProcess.Name
                                relation = "Unknown"
                            }
                        }
                        $relation = if ($lineage.matches -and [int]$lineage.depth -eq 0) {
                            "Self"
                        }
                        elseif ($lineage.matches) {
                            "Descendant"
                        }
                        else {
                            "Unrelated"
                        }
                        $matches = $matches -and $managedMatches -and [bool]$lineage.matches
                    }
                }
            }
        }
        return [pscustomobject]@{
            known = $true
            pid = [int]$ownerProcessId
            processName = [string]$process.Name
            matchesExpected = if ($ownershipConfigured) { $matches } else { $null }
            managedPid = $managedPid
            managedProcessName = if ($null -eq $managedProcess) { $null } else { [string]$managedProcess.Name }
            relation = $relation
        }
    }
    catch {
        return [pscustomobject]@{
            known = $false; pid = $null; processName = $null; matchesExpected = $null
            managedPid = $null; managedProcessName = $null; relation = "Unknown"
        }
    }
}

function Get-McpCcProbeResult {
    param(
        [Parameter(Mandatory = $true)]$Probe,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
        $PortPolicy,
        [scriptblock]$TcpPortTester
    )
    $started = [Diagnostics.Stopwatch]::StartNew()
    $success = $false
    $errorCode = $null
    $errorMessage = $null
    $summary = [ordered]@{}
    $probeUri = [Uri]([string]$Probe.url)
    $portPolicyResult = Test-McpCcPortAgainstPolicy -Port ([int]$Probe.port) -HostName $probeUri.Host -Policy $PortPolicy
    try {
        if ($portPolicyResult.known -and -not $portPolicyResult.safe) {
            $errorCode = [string]$portPolicyResult.errorCode
            if ($errorCode -eq "PORT_EXCLUDED") {
                throw "Configured loopback port is inside a Windows excluded TCP range."
            }
            throw "Configured loopback port is inside the Windows dynamic TCP client range."
        }
        $response = Invoke-WebRequest -UseBasicParsing -Uri ([string]$Probe.url) -TimeoutSec $TimeoutSeconds
        if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) {
            throw "Unexpected HTTP status $($response.StatusCode)."
        }
        if ([string]$Probe.kind -eq "json") {
            try { $payload = [string]$response.Content | ConvertFrom-Json }
            catch {
                $errorCode = "INVALID_JSON"
                throw "Health endpoint did not return valid JSON."
            }
            $mismatches = @()
            $expectedResult = Get-McpCcObjectProperty -Object $Probe -Name "expected"
            if ($expectedResult.found -and $null -ne $expectedResult.value) {
                foreach ($property in $expectedResult.value.PSObject.Properties) {
                    $actualResult = Get-McpCcNestedProperty -Object $payload -Path $property.Name
                    if (-not $actualResult.found -or -not (Test-McpCcValueEqual -Actual $actualResult.value -Expected $property.Value)) {
                        $mismatches += $property.Name
                    }
                }
            }
            foreach ($field in @($Probe.summaryFields)) {
                $value = Get-McpCcNestedProperty -Object $payload -Path ([string]$field)
                if ($value.found) { $summary[[string]$field] = $value.value }
            }
            if ($mismatches.Count -gt 0) {
                $errorCode = "EXPECTED_MISMATCH"
                throw "Health contract mismatch: $($mismatches -join ', ')."
            }
            $success = $true
        }
        else {
            $content = ([string]$response.Content).Trim()
            $accepted = @($Probe.expectedText | ForEach-Object { ([string]$_).Trim().ToLowerInvariant() })
            if ($content.ToLowerInvariant() -notin $accepted) {
                $errorCode = "EXPECTED_MISMATCH"
                throw "Readiness response was not an accepted marker."
            }
            $summary["marker"] = $content
            $success = $true
        }
    }
    catch {
        if ([string]::IsNullOrWhiteSpace($errorCode)) {
            if ($_.Exception -is [System.TimeoutException] -or $_.Exception.Message -match '(?i)timed out|timeout') {
                $errorCode = "TIMEOUT"
            }
            else {
                $errorCode = "HTTP_ERROR"
            }
        }
        $errorMessage = ([string]$_.Exception.Message -replace '[\r\n]+', ' ').Trim()
        if ($errorMessage.Length -gt 240) { $errorMessage = $errorMessage.Substring(0, 240) }
    }
    finally { $started.Stop() }

    $tcpOpen = if ($success) {
        $true
    }
    elseif ($null -ne $TcpPortTester) {
        [bool](& $TcpPortTester ([int]$Probe.port))
    }
    else {
        Test-McpCcTcpPort -Port ([int]$Probe.port)
    }
    $ownerFragmentsResult = Get-McpCcObjectProperty -Object $Probe -Name "ownerCommandContains"
    $managedPidPathResult = Get-McpCcObjectProperty -Object $Probe -Name "resolvedOwnerManagedPidFile"
    $managedFragmentsResult = Get-McpCcObjectProperty -Object $Probe -Name "ownerManagedCommandContains"
    # Passing an inline subexpression that emits an empty array can make Windows
    # PowerShell bind the following named argument as this parameter's value.
    # Materialize each value first so managed-PID-only ownership stays exact.
    $ownerFragments = @(if ($ownerFragmentsResult.found) { @($ownerFragmentsResult.value) } else { @() })
    $managedPidPath = if ($managedPidPathResult.found) { [string]$managedPidPathResult.value } else { $null }
    $managedFragments = @(if ($managedFragmentsResult.found) { @($managedFragmentsResult.value) } else { @() })
    $owner = if ($tcpOpen) {
        Get-McpCcPortOwner `
            -Port ([int]$Probe.port) `
            -ExpectedCommandFragments $ownerFragments `
            -ManagedPidPath $managedPidPath `
            -ManagedExpectedCommandFragments $managedFragments
    }
    else {
        [pscustomobject]@{
            known = $false; pid = $null; processName = $null; matchesExpected = $null
            managedPid = $null; managedProcessName = $null; relation = $null
        }
    }
    return [pscustomobject]@{
        id = [string]$Probe.id
        label = [string]$Probe.label
        role = [string]$Probe.role
        required = [bool]$Probe.required
        url = [string]$Probe.url
        port = [int]$Probe.port
        success = $success
        elapsedMs = [int]$started.ElapsedMilliseconds
        tcpOpen = [bool]$tcpOpen
        errorCode = $errorCode
        error = $errorMessage
        summary = [pscustomobject]$summary
        owner = $owner
        portPolicy = $portPolicyResult
    }
}

function Resolve-McpCcComponentState {
    param(
        [Parameter(Mandatory = $true)]$Component,
        [Parameter(Mandatory = $true)][bool]$RootExists,
        [Parameter(Mandatory = $true)][bool]$StartActionExists,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$ProbeResults
    )
    if (-not $RootExists) { return "NotInstalled" }
    if (-not $StartActionExists) { return "Misconfigured" }
    if (@($ProbeResults | Where-Object { $_.errorCode -in @("PORT_EXCLUDED", "PORT_IN_DYNAMIC_RANGE") }).Count -gt 0) {
        return "Misconfigured"
    }
    if (@($ProbeResults | Where-Object { $_.owner.known -and $_.owner.matchesExpected -eq $false }).Count -gt 0) {
        return "OwnershipMismatch"
    }
    $coreFailures = @($ProbeResults | Where-Object { $_.role -eq "core" -and -not $_.success })
    if ($coreFailures.Count -gt 0) {
        if (@($coreFailures | Where-Object { $_.tcpOpen }).Count -gt 0) { return "Unhealthy" }
        return "Stopped"
    }
    if (@($ProbeResults | Where-Object { $_.role -eq "connectivity" -and -not $_.success }).Count -gt 0) {
        return "Degraded"
    }
    if (@($ProbeResults | Where-Object { $_.role -eq "dependency" -and -not $_.success }).Count -gt 0) {
        return "BlockedUpstream"
    }
    return "Ready"
}

function Get-McpCcRunningAcceptanceStates {
    param([Parameter(Mandatory = $true)]$Component)
    $states = @("Ready")
    if (@($Component.probes | Where-Object { $_.required -and $_.role -eq "dependency" }).Count -gt 0) {
        $states += "BlockedUpstream"
    }
    return [string[]]$states
}

function Get-McpCcStatusPresentation {
    param([string]$Status)

    switch ($Status) {
        "Ready" {
            return [pscustomobject]@{ level = "Ready"; symbol = [string][char]0x2713; label = "Ready" }
        }
        "Degraded" {
            return [pscustomobject]@{ level = "Warning"; symbol = [string][char]0x26A0; label = "Connectivity degraded" }
        }
        "BlockedUpstream" {
            return [pscustomobject]@{ level = "Warning"; symbol = [string][char]0x26A0; label = "Waiting for upstream" }
        }
        "Stopped" {
            return [pscustomobject]@{ level = "Warning"; symbol = [string][char]0x26A0; label = "Stopped" }
        }
        "Unhealthy" {
            return [pscustomobject]@{ level = "Critical"; symbol = [string][char]0x2715; label = "Unhealthy" }
        }
        "OwnershipMismatch" {
            return [pscustomobject]@{ level = "Critical"; symbol = [string][char]0x2715; label = "Ownership mismatch" }
        }
        "Misconfigured" {
            return [pscustomobject]@{ level = "Critical"; symbol = [string][char]0x2715; label = "Misconfigured" }
        }
        "NotInstalled" {
            return [pscustomobject]@{ level = "Critical"; symbol = [string][char]0x2715; label = "Not installed" }
        }
        default {
            return [pscustomobject]@{ level = "Unknown"; symbol = "?"; label = "Not checked" }
        }
    }
}

function Get-McpCcRestartMcpDecision {
    param([Parameter(Mandatory = $true)]$ComponentStatus)

    $status = [string]$ComponentStatus.status
    $issues = @(if ($null -ne $ComponentStatus.PSObject.Properties["issues"]) { $ComponentStatus.issues } else { @() })
    if (@($issues | Where-Object { [string]$_.code -eq "MONITOR_EXCEPTION" }).Count -gt 0) {
        return [pscustomobject]@{
            allowed = $false
            action = $null
            errorCode = "MONITOR_EXCEPTION"
            message = "Monitoring failed; restart is disabled until component ownership can be verified."
        }
    }

    switch ($status) {
        "Stopped" {
            return [pscustomobject]@{
                allowed = $true
                action = "ensure_running"
                errorCode = $null
                message = "Start the stopped component-owned runtime."
            }
        }
        { $_ -in @("Ready", "Degraded", "BlockedUpstream", "Unhealthy") } {
            return [pscustomobject]@{
                allowed = $true
                action = "reload_runtime"
                errorCode = $null
                message = "Reload the complete component-owned runtime."
            }
        }
        "OwnershipMismatch" {
            return [pscustomobject]@{ allowed = $false; action = $null; errorCode = "OWNERSHIP_MISMATCH"; message = "Ownership could not be verified." }
        }
        "Misconfigured" {
            return [pscustomobject]@{ allowed = $false; action = $null; errorCode = "MISCONFIGURED"; message = "The component configuration must be repaired first." }
        }
        "NotInstalled" {
            return [pscustomobject]@{ allowed = $false; action = $null; errorCode = "NOT_INSTALLED"; message = "The component is not installed." }
        }
        default {
            return [pscustomobject]@{ allowed = $false; action = $null; errorCode = "RESTART_STATE_UNSUPPORTED"; message = "The component state is not safe for restart." }
        }
    }
}

function Get-McpCcActionErrorCode {
    param([string]$Message)

    foreach ($code in @(
        "MONITOR_EXCEPTION",
        "OWNERSHIP_MISMATCH",
        "MISCONFIGURED",
        "NOT_INSTALLED",
        "ACTIVE_WORK_PRESENT",
        "ACTION_BUSY",
        "SERVER_NOT_READY",
        "CORE_NOT_READY",
        "TUNNEL_NOT_READY",
        "TUNNEL_KEY_MISSING",
        "TUNNEL_PROFILE_MISSING",
        "TUNNEL_PROFILE_INVALID",
        "TUNNEL_ID_MISSING",
        "TUNNEL_ID_INVALID",
        "TUNNEL_ID_MISMATCH",
        "TUNNEL_CONFIG_MISSING",
        "POST_ACTION_NOT_READY",
        "RECONCILE_COMPONENT_FAILED",
        "RESTART_STATE_UNSUPPORTED",
        "CONTROLLER_REPORTED_FAILURE",
        "COMPONENT_UI_ACTION_FAILED"
    )) {
        if (-not [string]::IsNullOrWhiteSpace($Message) -and $Message -match ("(?<![A-Z0-9_])" + [Regex]::Escape($code) + "(?![A-Z0-9_])")) {
            return $code
        }
    }
    return "MANAGER_ACTION_FAILED"
}

function Get-McpCcSafeActionMessage {
    param([bool]$Ok, [string]$ErrorCode)

    if ($Ok) { return "Action completed." }
    switch ($ErrorCode) {
        "MONITOR_EXCEPTION" { return "Monitoring failed; restart is disabled until component ownership can be verified." }
        "OWNERSHIP_MISMATCH" { return "Ownership could not be verified; no runtime was changed." }
        "MISCONFIGURED" { return "The component configuration must be repaired before retrying." }
        "NOT_INSTALLED" { return "The component is not installed." }
        "ACTIVE_WORK_PRESENT" { return "Active work or a pending approval blocks this runtime change." }
        "ACTION_BUSY" { return "Another component lifecycle action is still running." }
        "SERVER_NOT_READY" { return "The component-owned server is not ready." }
        "CORE_NOT_READY" { return "The component-owned core is not ready." }
        "TUNNEL_NOT_READY" { return "The component-owned local tunnel is not ready." }
        "TUNNEL_KEY_MISSING" { return "The component-owned tunnel credential is unavailable." }
        "TUNNEL_PROFILE_MISSING" { return "The component-owned tunnel profile is missing." }
        "TUNNEL_PROFILE_INVALID" { return "The component-owned tunnel profile is invalid." }
        "TUNNEL_ID_MISSING" { return "The component-owned tunnel identity is missing." }
        "TUNNEL_ID_INVALID" { return "A component-owned tunnel identity is invalid." }
        "TUNNEL_ID_MISMATCH" { return "Component-owned tunnel identity sources disagree." }
        "TUNNEL_CONFIG_MISSING" { return "The component-owned tunnel configuration is incomplete." }
        "POST_ACTION_NOT_READY" { return "The lifecycle action completed, but required readiness was not restored." }
        "RECONCILE_COMPONENT_FAILED" { return "Component reconciliation failed; inspect component-owned runtime logs." }
        "RESTART_STATE_UNSUPPORTED" { return "The component state is not safe for restart." }
        default { return "The action failed; inspect component-owned runtime logs." }
    }
}

function ConvertTo-McpCcUtcDateTimeOffset {
    param([Parameter(Mandatory = $true)]$Value)

    if ($Value -is [DateTimeOffset]) { return $Value.ToUniversalTime() }
    if ($Value -is [DateTime]) { return ([DateTimeOffset]$Value).ToUniversalTime() }
    return [DateTimeOffset]::Parse(
        [string]$Value,
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind
    ).ToUniversalTime()
}

function ConvertTo-McpCcRemoteConnectivityEvidence {
    param(
        $Evidence,
        [Parameter(Mandatory = $true)][ValidateSet("remote_registration", "chatgpt_connector")][string]$Scope,
        [DateTimeOffset]$NowUtc = [DateTimeOffset]::UtcNow
    )

    if ($null -eq $Evidence) {
        return [pscustomobject]@{
            scope = $Scope
            status = "NotChecked"
            observedStatus = "NotChecked"
            checkedAt = $null
            validUntil = $null
            errorCode = $null
            source = "none"
        }
    }

    $statusResult = Get-McpCcObjectProperty -Object $Evidence -Name "status"
    $sourceResult = Get-McpCcObjectProperty -Object $Evidence -Name "source"
    $status = if ($statusResult.found) { [string]$statusResult.value } else { "" }
    $source = if ($sourceResult.found) { [string]$sourceResult.value } else { "component_controller" }
    if ($source -notmatch '^[a-z][a-z0-9_]{0,63}$') { $source = "invalid" }
    if ($status -notin @("Ready", "Failed", "Unknown", "NotChecked", "Stale")) {
        return [pscustomobject]@{
            scope = $Scope
            status = "Unknown"
            observedStatus = "Unknown"
            checkedAt = $null
            validUntil = $null
            errorCode = "REMOTE_EVIDENCE_INVALID"
            source = $source
        }
    }
    if ($status -eq "NotChecked") {
        return [pscustomobject]@{
            scope = $Scope
            status = "NotChecked"
            observedStatus = "NotChecked"
            checkedAt = $null
            validUntil = $null
            errorCode = $null
            source = $source
        }
    }

    try {
        $checkedAtResult = Get-McpCcObjectProperty -Object $Evidence -Name "checkedAt"
        $validUntilResult = Get-McpCcObjectProperty -Object $Evidence -Name "validUntil"
        if (-not $checkedAtResult.found -or -not $validUntilResult.found) { throw "missing timestamp" }
        $checkedAt = ConvertTo-McpCcUtcDateTimeOffset -Value $checkedAtResult.value
        $validUntil = ConvertTo-McpCcUtcDateTimeOffset -Value $validUntilResult.value
        if ($validUntil -lt $checkedAt) { throw "invalid TTL" }
    }
    catch {
        return [pscustomobject]@{
            scope = $Scope
            status = "Unknown"
            observedStatus = $status
            checkedAt = $null
            validUntil = $null
            errorCode = "REMOTE_EVIDENCE_INVALID"
            source = $source
        }
    }

    $errorCodeResult = Get-McpCcObjectProperty -Object $Evidence -Name "errorCode"
    $errorCode = if ($errorCodeResult.found) { [string]$errorCodeResult.value } else { $null }
    if (-not [string]::IsNullOrWhiteSpace($errorCode) -and $errorCode -notmatch '^[A-Z][A-Z0-9_]{0,63}$') {
        $status = "Unknown"
        $errorCode = "REMOTE_EVIDENCE_INVALID"
    }
    elseif ($status -eq "Failed" -and [string]::IsNullOrWhiteSpace($errorCode)) {
        $errorCode = "REMOTE_CONNECTIVITY_FAILED"
    }
    $projectedStatus = if ($validUntil -lt $NowUtc.ToUniversalTime()) { "Stale" } else { $status }
    return [pscustomobject]@{
        scope = $Scope
        status = $projectedStatus
        observedStatus = $status
        checkedAt = $checkedAt.ToString("o")
        validUntil = $validUntil.ToString("o")
        errorCode = $errorCode
        source = $source
    }
}

function New-McpCcConnectivityDetail {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$ProbeResults,
        [string]$CheckedAt = ([DateTimeOffset]::UtcNow.ToString("o")),
        $RemoteEvidence,
        [DateTimeOffset]$NowUtc = [DateTimeOffset]::UtcNow,
        [ValidateSet("Observed", "Unknown", "NotChecked")][string]$LocalObservation = "Observed"
    )

    $connectivityProbes = @($ProbeResults | Where-Object { [string]$_.role -eq "connectivity" })
    if ($LocalObservation -ne "Observed") {
        $localTunnel = [pscustomobject]@{
            scope = "local_tunnel"
            status = $LocalObservation
            checkedAt = if ($LocalObservation -eq "NotChecked") { $null } else { $CheckedAt }
            errorCode = if ($LocalObservation -eq "Unknown") { "MONITOR_EXCEPTION" } else { $null }
            source = "loopback_probe"
        }
    }
    elseif ($connectivityProbes.Count -eq 0) {
        $localTunnel = [pscustomobject]@{
            scope = "local_tunnel"
            status = "NotConfigured"
            checkedAt = $CheckedAt
            errorCode = $null
            source = "none"
        }
    }
    else {
        $ownershipMismatch = @($connectivityProbes | Where-Object { $_.owner.known -and $_.owner.matchesExpected -eq $false }).Count -gt 0
        $failedProbe = @($connectivityProbes | Where-Object { -not [bool]$_.success } | Select-Object -First 1)
        $localStatus = if ($ownershipMismatch) { "OwnershipMismatch" } elseif ($failedProbe.Count -gt 0) { "Failed" } else { "Ready" }
        $localErrorCode = if ($ownershipMismatch) {
            "OWNERSHIP_MISMATCH"
        }
        elseif ($failedProbe.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace([string]$failedProbe[0].errorCode)) {
            [string]$failedProbe[0].errorCode
        }
        elseif ($failedProbe.Count -gt 0) {
            "TUNNEL_NOT_READY"
        }
        else { $null }
        $localTunnel = [pscustomobject]@{
            scope = "local_tunnel"
            status = $localStatus
            checkedAt = $CheckedAt
            errorCode = $localErrorCode
            source = "loopback_probe"
        }
    }

    $registrationInput = $null
    $connectorInput = $null
    if ($null -ne $RemoteEvidence) {
        $registrationResult = Get-McpCcObjectProperty -Object $RemoteEvidence -Name "remoteRegistration"
        if ($registrationResult.found) { $registrationInput = $registrationResult.value }
        $connectorResult = Get-McpCcObjectProperty -Object $RemoteEvidence -Name "chatgptConnector"
        if ($connectorResult.found) { $connectorInput = $connectorResult.value }
    }
    return [pscustomobject]@{
        contractVersion = "component-connectivity-v1"
        localTunnel = $localTunnel
        remoteRegistration = ConvertTo-McpCcRemoteConnectivityEvidence -Evidence $registrationInput -Scope "remote_registration" -NowUtc $NowUtc
        chatgptConnector = ConvertTo-McpCcRemoteConnectivityEvidence -Evidence $connectorInput -Scope "chatgpt_connector" -NowUtc $NowUtc
    }
}

function Read-McpCcRemoteEvidenceFile {
    param(
        [Parameter(Mandatory = $true)]$Component,
        [ValidateRange(1024, 65536)][int]$MaxBytes = 8192,
        [DateTimeOffset]$NowUtc = [DateTimeOffset]::UtcNow
    )

    $bindingResult = Get-McpCcObjectProperty -Object $Component -Name "connectivityEvidence"
    if (-not $bindingResult.found -or $null -eq $bindingResult.value) { return $null }
    $pathResult = Get-McpCcObjectProperty -Object $bindingResult.value -Name "resolvedRemoteEvidencePath"
    if (-not $pathResult.found -or [string]::IsNullOrWhiteSpace([string]$pathResult.value)) { return $null }
    $path = [string]$pathResult.value
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }

    try {
        $item = Get-Item -LiteralPath $path -ErrorAction Stop
        if ([int64]$item.Length -gt $MaxBytes) { throw "evidence exceeds size limit" }
        $document = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
        Assert-McpCcObjectShape `
            -Object $document `
            -Allowed @("contractVersion", "remoteRegistration", "chatgptConnector") `
            -Required @("contractVersion") `
            -Label "Remote connectivity evidence"
        if ([string]$document.contractVersion -ne "component-connectivity-v1") { throw "unsupported evidence contract" }
        $evidenceCount = 0
        foreach ($name in @("remoteRegistration", "chatgptConnector")) {
            $evidenceResult = Get-McpCcObjectProperty -Object $document -Name $name
            if (-not $evidenceResult.found) { continue }
            $evidenceCount += 1
            Assert-McpCcObjectShape `
                -Object $evidenceResult.value `
                -Allowed @("status", "checkedAt", "validUntil", "errorCode", "source") `
                -Required @("status", "checkedAt", "validUntil", "errorCode", "source") `
                -Label "Remote connectivity evidence '$name'"
        }
        if ($evidenceCount -eq 0) { throw "evidence has no supported layer" }
        return $document
    }
    catch {
        $checkedAt = $NowUtc.ToUniversalTime()
        return [pscustomobject]@{
            contractVersion = "component-connectivity-v1"
            remoteRegistration = [pscustomobject]@{
                status = "Unknown"
                checkedAt = $checkedAt.ToString("o")
                validUntil = $checkedAt.AddMinutes(5).ToString("o")
                errorCode = "REMOTE_EVIDENCE_INVALID"
                source = "component_evidence_file"
            }
        }
    }
}

function Resolve-McpCcStatusWithConnectivity {
    param(
        [Parameter(Mandatory = $true)][string]$LocalStatus,
        [Parameter(Mandatory = $true)]$Connectivity
    )

    if ($LocalStatus -ne "Ready") { return $LocalStatus }
    if (
        [string]$Connectivity.remoteRegistration.status -eq "Failed" -or
        [string]$Connectivity.chatgptConnector.status -eq "Failed"
    ) {
        return "Degraded"
    }
    return $LocalStatus
}

function Get-McpCcReadinessScope {
    param(
        [Parameter(Mandatory = $true)][string]$LocalStatus,
        [Parameter(Mandatory = $true)]$Connectivity
    )

    if ([string]$Connectivity.localTunnel.status -ne "Ready") {
        if ($LocalStatus -eq "Degraded") { return "core" }
        return "none"
    }
    if ([string]$Connectivity.chatgptConnector.status -eq "Ready") { return "end_to_end" }
    if ([string]$Connectivity.remoteRegistration.status -eq "Ready") { return "remote_registration" }
    return "local"
}

function Write-McpCcLastActionResult {
    param(
        [Parameter(Mandatory = $true)][string]$RuntimeRoot,
        [Parameter(Mandatory = $true)][string]$Component,
        [Parameter(Mandatory = $true)][string]$Action,
        [string]$RoutedAction,
        [string]$UiAction,
        [Parameter(Mandatory = $true)][bool]$Ok,
        [string]$ErrorCode
    )

    if ($Component -notmatch '^[a-z][a-z0-9_]{0,63}$') { throw "Last-action component id is invalid." }
    $root = Assert-McpCcSafeRuntimeRoot -RuntimeRoot $RuntimeRoot
    $normalizedErrorCode = if ($Ok) { $null } elseif ([string]::IsNullOrWhiteSpace($ErrorCode)) { "MANAGER_ACTION_FAILED" } else { $ErrorCode }
    $document = [pscustomobject]@{
        schemaVersion = 1
        generatedAt = [DateTime]::UtcNow.ToString("o")
        component = $Component
        action = $Action
        routedAction = if ([string]::IsNullOrWhiteSpace($RoutedAction)) { $null } else { $RoutedAction }
        uiAction = if ([string]::IsNullOrWhiteSpace($UiAction)) { $null } else { $UiAction }
        ok = $Ok
        errorCode = $normalizedErrorCode
        message = Get-McpCcSafeActionMessage -Ok $Ok -ErrorCode $normalizedErrorCode
    }
    $lastActionRoot = Join-Path $root "last-actions"
    New-Item -ItemType Directory -Force -Path $lastActionRoot | Out-Null
    Write-McpCcJsonAtomic -Path (Join-Path $lastActionRoot "$Component.json") -Document $document
    return $document
}

function Read-McpCcLastActionResult {
    param(
        [Parameter(Mandatory = $true)][string]$RuntimeRoot,
        [Parameter(Mandatory = $true)][string]$Component
    )

    if ($Component -notmatch '^[a-z][a-z0-9_]{0,63}$') { throw "Last-action component id is invalid." }
    $path = Join-Path (Join-Path (Assert-McpCcSafeRuntimeRoot -RuntimeRoot $RuntimeRoot) "last-actions") "$Component.json"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try {
        $document = Get-Content -LiteralPath $path -Encoding UTF8 -Raw | ConvertFrom-Json
        if (
            [int]$document.schemaVersion -ne 1 -or
            [string]::IsNullOrWhiteSpace([string]$document.component) -or
            [string]::IsNullOrWhiteSpace([string]$document.action) -or
            $document.ok -isnot [bool]
        ) {
            return $null
        }
        return $document
    }
    catch { return $null }
}

function Get-McpCcTrayComponentModel {
    param([Parameter(Mandatory = $true)]$Component)

    $capabilitiesResult = Get-McpCcObjectProperty -Object $Component -Name "capabilities"
    $capabilities = if ($capabilitiesResult.found) { @($capabilitiesResult.value | ForEach-Object { [string]$_ }) } else { @() }
    $traitsResult = Get-McpCcObjectProperty -Object $Component -Name "traits"
    $traits = if ($traitsResult.found) { @($traitsResult.value | ForEach-Object { [string]$_ }) } else { @() }
    $actions = @()
    if ("ensure_running" -in $capabilities -and "reload_runtime" -in $capabilities) {
        $actions += [pscustomobject]@{ id = "restart_mcp"; label = "Restart MCP"; kind = "manager-action"; target = "RestartMcp" }
    }
    $actions += [pscustomobject]@{ id = "open_health"; label = "Open MCP health"; kind = "health-detail"; target = [string]$Component.id }

    $frontend = $null
    if ("primary-ui" -in $traits) {
        $uiResult = Get-McpCcObjectProperty -Object $Component -Name "ui"
        if ($uiResult.found -and $null -ne $uiResult.value) {
            $launcherResult = Get-McpCcObjectProperty -Object $uiResult.value -Name "primaryLauncher"
            if ($launcherResult.found -and $null -ne $launcherResult.value) {
                $frontend = [pscustomobject]@{
                    kind = "vbs"
                    label = "Open $([string]$Component.displayName)"
                    path = [string]$launcherResult.value.path
                    target = $null
                }
            }
        }
        if ($null -eq $frontend) {
            $navigationResult = Get-McpCcObjectProperty -Object $Component -Name "navigation"
            $navigation = if ($navigationResult.found) { @($navigationResult.value) } else { @() }
            $primaryNavigation = @($navigation | Where-Object { [string]$_.id -eq "primary_ui" -and [string]$_.kind -eq "loopback-url" } | Select-Object -First 1)
            if ($primaryNavigation.Count -eq 1) {
                $frontendLabel = [string]$primaryNavigation[0].label
                if ([string]::IsNullOrWhiteSpace($frontendLabel) -or $frontendLabel -eq "Open primary UI") {
                    $frontendLabel = "Open $([string]$Component.displayName)"
                }
                $frontend = [pscustomobject]@{
                    kind = "loopback-url"
                    label = $frontendLabel
                    path = $null
                    target = [string]$primaryNavigation[0].target
                }
            }
        }
    }
    if ($null -ne $frontend) {
        $actions += [pscustomobject]@{ id = "open_frontend"; label = [string]$frontend.label; kind = [string]$frontend.kind; target = $frontend }
    }

    return [pscustomobject]@{
        id = [string]$Component.id
        displayName = [string]$Component.displayName
        actions = $actions
        frontend = $frontend
    }
}

function Get-McpCcComponentHealthModel {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$ComponentId,
        $LastAction
    )

    $definition = Get-McpCcComponent -Manifest $Manifest -Id $ComponentId
    $stateEntries = @($State.components | Where-Object { [string]$_.id -eq $ComponentId } | Select-Object -First 1)
    $componentState = if ($stateEntries.Count -eq 1) { $stateEntries[0] } else {
        [pscustomobject]@{
            id = $ComponentId
            displayName = [string]$definition.displayName
            status = "NotChecked"
            localStatus = "NotChecked"
            readinessScope = "none"
            checkedAt = $null
            elapsedMs = 0
            healthUrl = $null
            probes = @()
            issues = @()
        }
    }
    $connectivityResult = Get-McpCcObjectProperty -Object $componentState -Name "connectivity"
    $connectivity = if ($connectivityResult.found -and $null -ne $connectivityResult.value) {
        $connectivityResult.value
    }
    else {
        New-McpCcConnectivityDetail -ProbeResults @($componentState.probes) -CheckedAt ([string]$componentState.checkedAt) -LocalObservation $(if ([string]$componentState.status -eq "NotChecked") { "NotChecked" } else { "Observed" })
    }
    $localStatusResult = Get-McpCcObjectProperty -Object $componentState -Name "localStatus"
    $localStatus = if ($localStatusResult.found) { [string]$localStatusResult.value } else { [string]$componentState.status }
    $scopeResult = Get-McpCcObjectProperty -Object $componentState -Name "readinessScope"
    $readinessScope = if ($scopeResult.found) { [string]$scopeResult.value } else { Get-McpCcReadinessScope -LocalStatus $localStatus -Connectivity $connectivity }
    $presentation = Get-McpCcStatusPresentation -Status ([string]$componentState.status)
    $statusLabel = if ([string]$componentState.status -eq "Ready" -and $readinessScope -eq "local") {
        "Ready locally"
    }
    elseif ([string]$componentState.status -eq "Ready" -and $readinessScope -eq "remote_registration") {
        "Remote registered"
    }
    elseif ([string]$componentState.status -eq "Ready" -and $readinessScope -eq "end_to_end") {
        "End-to-end ready"
    }
    else { [string]$presentation.label }
    $probes = @()
    foreach ($probe in @($componentState.probes)) {
        $ownerResult = Get-McpCcObjectProperty -Object $probe -Name "owner"
        $owner = if ($ownerResult.found -and $null -ne $ownerResult.value) { $ownerResult.value } else { $null }
        $ownerKnown = $null -ne $owner -and [bool]$owner.known
        $ownerMatches = if ($ownerKnown) { $owner.matchesExpected } else { $null }
        $ownershipLabel = if (-not [bool]$probe.tcpOpen) {
            "Not listening"
        }
        elseif (-not $ownerKnown) {
            "Unknown"
        }
        elseif ($ownerMatches -eq $false) {
            "Mismatch"
        }
        elseif ($ownerMatches -eq $true) {
            "Verified"
        }
        else {
            "Observed"
        }
        $probes += [pscustomobject]@{
            id = [string]$probe.id
            label = [string]$probe.label
            role = [string]$probe.role
            required = [bool]$probe.required
            url = [string]$probe.url
            port = [int]$probe.port
            success = [bool]$probe.success
            elapsedMs = [int]$probe.elapsedMs
            tcpOpen = [bool]$probe.tcpOpen
            errorCode = [string]$probe.errorCode
            error = [string]$probe.error
            ownership = $ownershipLabel
            ownerKnown = $ownerKnown
            ownerPid = if ($ownerKnown) { $owner.pid } else { $null }
            managedPid = if ($ownerKnown) { $owner.managedPid } else { $null }
            processName = if ($ownerKnown) { [string]$owner.processName } else { $null }
            relation = if ($ownerKnown) { [string]$owner.relation } else { $null }
            matchesExpected = $ownerMatches
        }
    }

    $actionIds = @()
    $uiResult = Get-McpCcObjectProperty -Object $definition -Name "ui"
    if ($uiResult.found -and $null -ne $uiResult.value) {
        $menuActionsResult = Get-McpCcObjectProperty -Object $uiResult.value -Name "menuActions"
        if ($menuActionsResult.found) {
            $actionIds = @($menuActionsResult.value | ForEach-Object { [string]$_.id })
        }
    }
    $healthUrl = [string]$componentState.healthUrl
    if ([string]::IsNullOrWhiteSpace($healthUrl)) {
        $primaryProbe = @($definition.probes | Where-Object { [string]$_.role -eq "core" } | Select-Object -First 1)
        if ($primaryProbe.Count -eq 1) { $healthUrl = [string]$primaryProbe[0].url }
    }
    $tunnelProbe = @($probes | Where-Object { [string]$_.role -eq "connectivity" } | Select-Object -First 1)
    $componentLastAction = if ($null -ne $LastAction -and [string]$LastAction.component -eq $ComponentId) { $LastAction } else { $null }

    return [pscustomobject]@{
        id = $ComponentId
        displayName = [string]$definition.displayName
        status = [string]$componentState.status
        localStatus = $localStatus
        readinessScope = $readinessScope
        connectivity = $connectivity
        level = [string]$presentation.level
        symbol = [string]$presentation.symbol
        statusLabel = $statusLabel
        checkedAt = $componentState.checkedAt
        elapsedMs = [int]$componentState.elapsedMs
        generatedAt = $State.generatedAt
        healthUrl = $healthUrl
        componentRoot = [string]$definition.resolvedRoot
        probes = $probes
        issues = @($componentState.issues)
        tunnelReady = $tunnelProbe.Count -eq 1 -and [bool]$tunnelProbe[0].success
        actionIds = $actionIds
        lastAction = $componentLastAction
    }
}

function Get-McpCcComponentStatus {
    param(
        [Parameter(Mandatory = $true)]$Component,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
        $RemoteEvidence,
        $PortPolicy,
        [DateTimeOffset]$NowUtc = [DateTimeOffset]::UtcNow
    )
    $started = [Diagnostics.Stopwatch]::StartNew()
    $rootExists = Test-Path -LiteralPath $Component.resolvedRoot -PathType Container
    $startBinding = Get-McpCcComponentActionBinding -Component $Component -Action "ensure_running"
    $startPath = Resolve-McpCcChildPath `
        -Root $Component.resolvedRoot `
        -RelativePath ([string]$startBinding.actionSpec.path) `
        -Label "ensure_running action"
    $startExists = $null -ne $startPath -and (Test-Path -LiteralPath $startPath -PathType Leaf)
    $probeResults = @()
    if ($rootExists) {
        foreach ($probe in @($Component.probes)) {
            $probeResults += Get-McpCcProbeResult -Probe $probe -TimeoutSeconds $TimeoutSeconds -PortPolicy $PortPolicy
        }
    }
    $localStatus = Resolve-McpCcComponentState -Component $Component -RootExists $rootExists -StartActionExists $startExists -ProbeResults $probeResults
    $checkedAt = $NowUtc.ToUniversalTime().ToString("o")
    if (-not $PSBoundParameters.ContainsKey("RemoteEvidence")) {
        $RemoteEvidence = Read-McpCcRemoteEvidenceFile -Component $Component -NowUtc $NowUtc
    }
    $connectivity = New-McpCcConnectivityDetail -ProbeResults $probeResults -CheckedAt $checkedAt -RemoteEvidence $RemoteEvidence -NowUtc $NowUtc
    $status = Resolve-McpCcStatusWithConnectivity -LocalStatus $localStatus -Connectivity $connectivity
    $readinessScope = Get-McpCcReadinessScope -LocalStatus $localStatus -Connectivity $connectivity
    $issues = @($probeResults | Where-Object { -not $_.success } | ForEach-Object {
        [pscustomobject]@{ probe = $_.id; code = $_.errorCode; message = $_.error }
    })
    if ([string]$connectivity.remoteRegistration.status -eq "Failed") {
        $issues += [pscustomobject]@{ probe = "remoteRegistration"; code = [string]$connectivity.remoteRegistration.errorCode; message = "Remote tunnel registration failed." }
    }
    if ([string]$connectivity.chatgptConnector.status -eq "Failed") {
        $issues += [pscustomobject]@{ probe = "chatgptConnector"; code = [string]$connectivity.chatgptConnector.errorCode; message = "ChatGPT connector validation failed." }
    }
    $started.Stop()
    $primaryProbe = @($Component.probes | Where-Object { $_.role -eq "core" } | Select-Object -First 1)
    return [pscustomobject]@{
        id = [string]$Component.id
        displayName = [string]$Component.displayName
        runtimeMode = Get-McpCcRuntimeMode -Component $Component
        capabilities = @($Component.capabilities)
        autoStart = [bool]$Component.autoStart
        startupOrder = [int]$Component.startupOrder
        status = $status
        localStatus = $localStatus
        readinessScope = $readinessScope
        connectivity = $connectivity
        checkedAt = $checkedAt
        elapsedMs = [int]$started.ElapsedMilliseconds
        rootExists = $rootExists
        startActionExists = $startExists
        healthUrl = if ($primaryProbe.Count -gt 0) { [string]$primaryProbe[0].url } else { $null }
        probes = $probeResults
        issues = $issues
    }
}

function New-McpCcMonitorExceptionStatus {
    param([Parameter(Mandatory = $true)]$Component)

    $primaryProbe = @($Component.probes | Where-Object { $_.role -eq "core" } | Select-Object -First 1)
    $checkedAt = [DateTimeOffset]::UtcNow.ToString("o")
    $connectivity = New-McpCcConnectivityDetail -ProbeResults @() -CheckedAt $checkedAt -LocalObservation "Unknown"
    return [pscustomobject]@{
        id = [string]$Component.id
        displayName = [string]$Component.displayName
        runtimeMode = Get-McpCcRuntimeMode -Component $Component
        capabilities = @($Component.capabilities)
        autoStart = [bool]$Component.autoStart
        startupOrder = [int]$Component.startupOrder
        status = "Unhealthy"
        localStatus = "Unhealthy"
        readinessScope = "none"
        connectivity = $connectivity
        checkedAt = $checkedAt
        elapsedMs = 0
        rootExists = $null
        startActionExists = $null
        healthUrl = if ($primaryProbe.Count -gt 0) { [string]$primaryProbe[0].url } else { $null }
        probes = @()
        issues = @([pscustomobject]@{
            probe = $null
            code = "MONITOR_EXCEPTION"
            message = "Component monitoring failed; inspect control-center diagnostics."
        })
    }
}

function Get-McpCcSystemState {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [string]$BootId = (Get-McpCcBootId),
        [scriptblock]$StatusProvider,
        $PortPolicy
    )
    $effectivePortPolicy = if ($PSBoundParameters.ContainsKey("PortPolicy")) {
        $PortPolicy
    }
    elseif ($null -eq $StatusProvider) {
        Get-McpCcWindowsTcpPortPolicy
    }
    else {
        $null
    }
    $components = @()
    foreach ($component in @($Manifest.components | Sort-Object startupOrder)) {
        try {
            if ($null -eq $StatusProvider) {
                $components += Get-McpCcComponentStatus -Component $component -TimeoutSeconds ([int]$Manifest.settings.probeTimeoutSeconds) -PortPolicy $effectivePortPolicy
            }
            else {
                $components += & $StatusProvider $component ([int]$Manifest.settings.probeTimeoutSeconds)
            }
        }
        catch {
            $components += New-McpCcMonitorExceptionStatus -Component $component
        }
    }
    $severe = @("NotInstalled", "Misconfigured", "OwnershipMismatch", "Unhealthy")
    $overall = if (@($components | Where-Object { $_.status -in $severe }).Count -gt 0) {
        "Failed"
    }
    elseif (@($components | Where-Object { $_.status -ne "Ready" }).Count -gt 0) {
        "Degraded"
    }
    else { "Ready" }
    $counts = [ordered]@{}
    foreach ($statusName in @("Ready", "Degraded", "BlockedUpstream", "Stopped", "Unhealthy", "OwnershipMismatch", "Misconfigured", "NotInstalled")) {
        $counts[$statusName] = @($components | Where-Object { $_.status -eq $statusName }).Count
    }
    return [pscustomobject]@{
        schemaVersion = 1
        generatedAt = [DateTime]::UtcNow.ToString("o")
        bootId = $BootId
        overall = $overall
        counts = [pscustomobject]$counts
        portPolicy = ConvertTo-McpCcPortPolicySummary -Policy $effectivePortPolicy
        components = $components
    }
}

function Assert-McpCcSafeRuntimeRoot {
    param([Parameter(Mandatory = $true)][string]$RuntimeRoot)
    $full = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\', '/')
    $driveRoot = [IO.Path]::GetPathRoot($full).TrimEnd('\', '/')
    if ([string]::IsNullOrWhiteSpace($full) -or $full.Equals($driveRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Runtime root must not be a drive root."
    }
    return $full
}

function ConvertTo-McpCcSafeObject {
    param($Value, [string]$PropertyName = "")
    if ($PropertyName -match '(?i)(token|secret|credential|authorization|api.?key|payload|response.?body|content)') {
        return "[redacted]"
    }
    if ($null -eq $Value) { return $null }
    if ($Value -is [string]) {
        $text = ($Value -replace '[\r\n]+', ' ').Trim()
        if ($text.Length -gt 500) { return $text.Substring(0, 500) + "..." }
        return $text
    }
    if ($Value -is [ValueType]) { return $Value }
    if ($Value -is [System.Collections.IDictionary]) {
        $safe = [ordered]@{}
        foreach ($key in $Value.Keys) { $safe[[string]$key] = ConvertTo-McpCcSafeObject -Value $Value[$key] -PropertyName ([string]$key) }
        return [pscustomobject]$safe
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        return @($Value | ForEach-Object { ConvertTo-McpCcSafeObject -Value $_ })
    }
    $object = [ordered]@{}
    foreach ($property in $Value.PSObject.Properties) {
        $object[$property.Name] = ConvertTo-McpCcSafeObject -Value $property.Value -PropertyName $property.Name
    }
    return [pscustomobject]$object
}

function Write-McpCcJsonAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Document
    )
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $temporary = "$Path.tmp.$PID.$([Guid]::NewGuid().ToString('N'))"
    try {
        [IO.File]::WriteAllText($temporary, ($Document | ConvertTo-Json -Depth 12), $script:Utf8NoBom)
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Write-McpCcEvent {
    param(
        [Parameter(Mandatory = $true)][string]$RuntimeRoot,
        [Parameter(Mandatory = $true)][string]$BootId,
        [Parameter(Mandatory = $true)][string]$Type,
        [string]$Component,
        $Details
    )
    $root = Assert-McpCcSafeRuntimeRoot -RuntimeRoot $RuntimeRoot
    $eventDirectory = Join-Path $root "events"
    New-Item -ItemType Directory -Force -Path $eventDirectory | Out-Null
    $event = [ordered]@{
        timestamp = [DateTime]::UtcNow.ToString("o")
        bootId = $BootId
        type = $Type
        component = $Component
        details = ConvertTo-McpCcSafeObject -Value $Details
    }
    $path = Join-Path $eventDirectory "$([DateTime]::UtcNow.ToString('yyyy-MM-dd')).jsonl"
    [IO.File]::AppendAllText($path, (($event | ConvertTo-Json -Compress -Depth 10) + [Environment]::NewLine), $script:Utf8NoBom)
}

function Read-McpCcState {
    param([Parameter(Mandatory = $true)][string]$RuntimeRoot)
    $path = Join-Path (Assert-McpCcSafeRuntimeRoot -RuntimeRoot $RuntimeRoot) "state.json"
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try { return Get-Content -LiteralPath $path -Encoding UTF8 -Raw | ConvertFrom-Json }
    catch { return $null }
}

function Remove-McpCcExpiredEvents {
    param(
        [Parameter(Mandatory = $true)][string]$RuntimeRoot,
        [Parameter(Mandatory = $true)][int]$RetentionDays
    )
    $root = Assert-McpCcSafeRuntimeRoot -RuntimeRoot $RuntimeRoot
    $eventDirectory = Join-Path $root "events"
    if (-not (Test-Path -LiteralPath $eventDirectory -PathType Container)) { return }
    $cutoff = [DateTime]::UtcNow.AddDays(-$RetentionDays)
    foreach ($file in @(Get-ChildItem -LiteralPath $eventDirectory -File -Filter "*.jsonl" -ErrorAction SilentlyContinue)) {
        if ($file.Name -match '^\d{4}-\d{2}-\d{2}\.jsonl$' -and $file.LastWriteTimeUtc -lt $cutoff) {
            Remove-Item -LiteralPath $file.FullName -Force
        }
    }
}

function Publish-McpCcState {
    param(
        [Parameter(Mandatory = $true)][string]$RuntimeRoot,
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][int]$RetentionDays
    )
    $root = Assert-McpCcSafeRuntimeRoot -RuntimeRoot $RuntimeRoot
    $previous = Read-McpCcState -RuntimeRoot $root
    if ($null -eq $previous -or [string]$previous.overall -ne [string]$State.overall) {
        Write-McpCcEvent -RuntimeRoot $root -BootId $State.bootId -Type "overall_status_changed" -Details @{
            previous = if ($null -eq $previous) { $null } else { [string]$previous.overall }
            current = [string]$State.overall
        }
    }
    foreach ($component in @($State.components)) {
        $previousComponent = if ($null -eq $previous) { $null } else { @($previous.components | Where-Object { $_.id -eq $component.id } | Select-Object -First 1) }
        $previousStatus = if ($null -eq $previousComponent -or @($previousComponent).Count -eq 0) { $null } else { [string]$previousComponent[0].status }
        if ($previousStatus -ne [string]$component.status) {
            Write-McpCcEvent -RuntimeRoot $root -BootId $State.bootId -Type "component_status_changed" -Component $component.id -Details @{
                previous = $previousStatus
                current = [string]$component.status
                issues = $component.issues
            }
        }
    }
    Write-McpCcJsonAtomic -Path (Join-Path $root "state.json") -Document $State
    Remove-McpCcExpiredEvents -RuntimeRoot $root -RetentionDays $RetentionDays
    return $State
}

function Test-McpCcComponentMenuContract {
    param([Parameter(Mandatory = $true)]$Component)
    $uiResult = Get-McpCcObjectProperty -Object $Component -Name "ui"
    if (-not $uiResult.found -or $null -eq $uiResult.value) {
        return [pscustomobject]@{ configured = $false; ok = $true; menuContract = $null; actions = @(); error = $null }
    }
    $menuContractResult = Get-McpCcObjectProperty -Object $uiResult.value -Name "menuContract"
    if (-not $menuContractResult.found) {
        return [pscustomobject]@{ configured = $false; ok = $true; menuContract = $null; actions = @(); error = $null }
    }
    try {
        $entrypoint = Resolve-McpCcChildPath -Root $Component.resolvedRoot -RelativePath ([string]$Component.ui.actionEntrypoint.path) -Label "Component '$($Component.id)' UI action entrypoint"
        if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) { throw "component UI action entrypoint is missing" }
        $output = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $entrypoint -SelfTest 2>&1)
        $exitCode = $LASTEXITCODE
        $outputText = ($output -join [Environment]::NewLine)
        if ([Text.Encoding]::UTF8.GetByteCount($outputText) -gt 65536) { throw "component UI SelfTest exceeded the output limit" }
        if ($exitCode -ne 0) { throw "component UI SelfTest exited with code $exitCode" }
        $document = $outputText | ConvertFrom-Json
        $declaredActions = @($document.actions | ForEach-Object { [string]$_ })
        $expectedActions = @($Component.ui.menuActions | ForEach-Object { [string]$_.id })
        $missingActions = @($expectedActions | Where-Object { $_ -notin $declaredActions })
        $unexpectedActions = @($declaredActions | Where-Object { $_ -notin $expectedActions })
        $ok = (
            $document.ok -eq $true -and
            [string]$document.menuContract -eq $script:ExpectedComponentMenuContract -and
            $missingActions.Count -eq 0 -and
            $unexpectedActions.Count -eq 0
        )
        return [pscustomobject]@{
            configured = $true
            ok = $ok
            menuContract = [string]$document.menuContract
            actions = $declaredActions
            expectedActions = $expectedActions
            error = if ($ok) { $null } else { "component does not satisfy component-menu-v1 contract" }
        }
    }
    catch {
        return [pscustomobject]@{
            configured = $true
            ok = $false
            menuContract = $script:ExpectedComponentMenuContract
            actions = @()
            error = ([string]$_.Exception.Message -replace '[\r\n]+', ' ')
        }
    }
}

function Test-McpCcComponentContract {
    param([Parameter(Mandatory = $true)]$Component)
    if (-not (Test-Path -LiteralPath $Component.resolvedContractScript -PathType Leaf)) {
        return [pscustomobject]@{ id = $Component.id; ok = $false; error = "contract script is missing" }
    }
    try {
        $runtimeMode = Get-McpCcRuntimeMode -Component $Component
        [string[]]$contractArguments = if ($runtimeMode -eq "component-controller") {
            @("-Action", "SelfTest")
        }
        else {
            @("-SelfTest")
        }
        $output = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Component.resolvedContractScript $contractArguments 2>&1)
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) { throw "component SelfTest exited with code $exitCode" }
        $document = ($output -join [Environment]::NewLine) | ConvertFrom-Json
        $componentMenu = Test-McpCcComponentMenuContract -Component $Component
        if ($runtimeMode -eq "component-controller") {
            $declaredCapabilities = @($document.capabilities | ForEach-Object { [string]$_ })
            $expectedCapabilities = @($Component.capabilities | ForEach-Object { [string]$_ })
            $missingCapabilities = @($expectedCapabilities | Where-Object { $_ -notin $declaredCapabilities })
            $unexpectedCapabilities = @($declaredCapabilities | Where-Object { $_ -notin $expectedCapabilities })
            $expectsDiagnosticTray = "show_diagnostic_tray" -in $expectedCapabilities
            $traitsResult = Get-McpCcObjectProperty -Object $Component -Name "traits"
            $expectsTunnel = if ($traitsResult.found) { "tunnel" -in @($traitsResult.value) } else { $true }
            $ok = (
                [string]$document.runtimeContract -eq $script:ExpectedLifecycleContract -and
                [string]$document.lifecycleModel -eq "stateless-controller" -and
                $document.supportsDiagnosticTray -eq $expectsDiagnosticTray -and
                $document.controllerEntryExists -eq $true -and
                $document.autoStartCore -eq $true -and
                $document.autoStartTunnel -eq $expectsTunnel -and
                $document.exitUiStopsRuntime -eq $false -and
                $document.exactOwnershipEnforced -eq $true -and
                $missingCapabilities.Count -eq 0 -and
                $unexpectedCapabilities.Count -eq 0 -and
                $componentMenu.ok
            )
            return [pscustomobject]@{
                id = [string]$Component.id
                ok = $ok
                runtimeMode = $runtimeMode
                runtimeContract = [string]$document.runtimeContract
                lifecycleModel = [string]$document.lifecycleModel
                capabilities = $declaredCapabilities
                expectedCapabilities = $expectedCapabilities
                supportsDiagnosticTray = [bool]$document.supportsDiagnosticTray
                controllerEntryExists = [bool]$document.controllerEntryExists
                autoStartCore = [bool]$document.autoStartCore
                autoStartTunnel = [bool]$document.autoStartTunnel
                exitUiStopsRuntime = [bool]$document.exitUiStopsRuntime
                exactOwnershipEnforced = [bool]$document.exactOwnershipEnforced
                componentMenu = $componentMenu
                error = if ($ok) { $null } elseif (-not $componentMenu.ok) { $componentMenu.error } else { "component does not satisfy unified lifecycle controller contract" }
            }
        }
        else {
            $ok = (
                [string]$document.trayMenuContract -eq $script:ExpectedTrayContract -and
                $document.autoStartServer -eq $true -and
                $document.autoStartTunnel -eq $true
            )
            return [pscustomobject]@{
                id = [string]$Component.id
                ok = $ok
                runtimeMode = $runtimeMode
                trayMenuContract = [string]$document.trayMenuContract
                autoStartServer = [bool]$document.autoStartServer
                autoStartTunnel = [bool]$document.autoStartTunnel
                componentMenu = $componentMenu
                error = if ($ok) { $null } else { "component does not satisfy unified always-on contract" }
            }
        }
    }
    catch {
        return [pscustomobject]@{ id = $Component.id; ok = $false; error = ([string]$_.Exception.Message -replace '[\r\n]+', ' ') }
    }
}

function Test-McpCcManifest {
    param([Parameter(Mandatory = $true)]$Manifest)
    $components = @()
    foreach ($component in @($Manifest.components | Sort-Object startupOrder)) {
        $actions = @()
        foreach ($name in @(Get-McpCcRequiredActionNames -Component $component)) {
            $action = (Get-McpCcObjectProperty -Object $component.actions -Name $name).value
            $path = Resolve-McpCcChildPath -Root $component.resolvedRoot -RelativePath ([string]$action.path) -Label "$name action"
            $actions += [pscustomobject]@{ name = $name; path = $path; exists = Test-Path -LiteralPath $path -PathType Leaf }
        }
        $contract = Test-McpCcComponentContract -Component $component
        $components += [pscustomobject]@{
            id = [string]$component.id
            displayName = [string]$component.displayName
            runtimeMode = Get-McpCcRuntimeMode -Component $component
            rootExists = Test-Path -LiteralPath $component.resolvedRoot -PathType Container
            actions = $actions
            contract = $contract
        }
    }
    $ok = @($components | Where-Object {
        -not $_.rootExists -or @($_.actions | Where-Object { -not $_.exists }).Count -gt 0 -or -not $_.contract.ok
    }).Count -eq 0
    return [pscustomobject]@{
        schemaVersion = [int]$Manifest.schemaVersion
        ok = $ok
        expectedTrayContract = $script:ExpectedTrayContract
        expectedLifecycleContract = $script:ExpectedLifecycleContract
        expectedComponentMenuContract = $script:ExpectedComponentMenuContract
        manifestPath = $Manifest.sourcePath
        componentCount = $components.Count
        registeredCount = if ((Get-McpCcObjectProperty -Object $Manifest -Name "registeredCount").found) { [int]$Manifest.registeredCount } else { $components.Count }
        enabledCount = if ((Get-McpCcObjectProperty -Object $Manifest -Name "enabledCount").found) { [int]$Manifest.enabledCount } else { $components.Count }
        components = $components
    }
}

function ConvertTo-McpCcWindowsArgument {
    param([AllowEmptyString()][string]$Value)
    if ([string]::IsNullOrEmpty($Value)) { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function Read-McpCcCapturedText {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return "" }
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -eq 0) { return "" }
    try {
        $encoding = New-Object Text.UTF8Encoding($false, $true)
        return $encoding.GetString($bytes).TrimStart([char]0xFEFF)
    }
    catch {
        return [Text.Encoding]::Default.GetString($bytes).TrimStart([char]0xFEFF)
    }
}

function Invoke-McpCcBoundedPowerShell {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$Arguments = @(),
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$RuntimeRoot,
        [Parameter(Mandatory = $true)][ValidateRange(1, 300)][int]$TimeoutSeconds,
        [ValidateRange(1024, 1048576)][int]$MaxCapturedOutputBytes = 65536
    )
    $root = Assert-McpCcSafeRuntimeRoot -RuntimeRoot $RuntimeRoot
    $captureRoot = Join-Path $root "action-capture"
    New-Item -ItemType Directory -Force -Path $captureRoot | Out-Null
    $process = $null
    $resultPipe = $null
    $resultReader = $null
    $resultLineTask = $null
    try {
        # The wrapper receives this one purpose-built handle, marks it
        # non-inheritable, and frames the controller result through it. Service
        # descendants therefore cannot keep the manager capture channel open.
        $resultPipe = New-Object IO.Pipes.AnonymousPipeServerStream(
            [IO.Pipes.PipeDirection]::In,
            [IO.HandleInheritability]::Inheritable
        )
        $resultReader = New-Object IO.StreamReader($resultPipe, [Text.Encoding]::UTF8, $true, 4096, $true)
        $wrapperPath = Join-Path (Split-Path -Parent $PSScriptRoot) "scripts\invoke-component-controller.ps1"
        if (-not (Test-Path -LiteralPath $wrapperPath -PathType Leaf)) { throw "Component controller wrapper is unavailable." }
        $argumentDocument = [pscustomobject]@{ arguments = @($Arguments) } | ConvertTo-Json -Compress
        $argumentsBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($argumentDocument))
        $processArguments = @(
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $wrapperPath,
            "-ControllerPath", $ScriptPath, "-ArgumentsBase64", $argumentsBase64,
            "-ResultPipeHandle", $resultPipe.GetClientHandleAsString(),
            "-MaxCapturedOutputBytes", [string]$MaxCapturedOutputBytes
        )
        $argumentLine = (@($processArguments | ForEach-Object { ConvertTo-McpCcWindowsArgument -Value ([string]$_) }) -join " ")
        $startInfo = New-Object Diagnostics.ProcessStartInfo
        $startInfo.FileName = Join-Path $PSHOME "powershell.exe"
        $startInfo.Arguments = $argumentLine
        $startInfo.WorkingDirectory = $WorkingDirectory
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $process = New-Object Diagnostics.Process
        $process.StartInfo = $startInfo
        if (-not $process.Start()) { throw "Unable to start the component lifecycle controller." }
        $resultPipe.DisposeLocalCopyOfClientHandle()
        $resultLineTask = $resultReader.ReadLineAsync()
        $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
        while (-not $process.WaitForExit(100)) {
            if ([DateTime]::UtcNow -ge $deadline) {
                Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
                $null = $process.WaitForExit(5000)
                throw "Component action timed out after $TimeoutSeconds seconds; status must be checked before retrying."
            }
        }
        $process.WaitForExit()
        if ($null -eq $resultLineTask -or -not $resultLineTask.Wait(1000)) {
            throw "Component controller did not return a complete framed result."
        }
        $frameLine = [string]$resultLineTask.Result
        if ([string]::IsNullOrWhiteSpace($frameLine) -or -not $frameLine.StartsWith("MCPCC1:", [StringComparison]::Ordinal)) {
            throw "Component controller did not return a valid framed result."
        }
        try {
            $frameJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($frameLine.Substring(7)))
            $frame = $frameJson | ConvertFrom-Json
        }
        catch { throw "Component controller returned a malformed framed result." }
        if ([string]$frame.protocol -ne "mcpcc-controller-result-v1") {
            throw "Component controller returned an unsupported framed result."
        }
        if ([bool]$frame.outputLimitExceeded) {
            throw "Component action exceeded the $MaxCapturedOutputBytes byte output limit; inspect the component-owned runtime log."
        }
        $controllerExitCode = 0
        if (-not [int]::TryParse([string]$frame.exitCode, [ref]$controllerExitCode) -or $controllerExitCode -notin @(0, 1)) {
            throw "Component controller returned an invalid exit code."
        }
        try {
            $controllerStdout = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$frame.stdoutBase64))
            $controllerStderr = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$frame.stderrBase64))
        }
        catch { throw "Component controller returned malformed captured output." }
        $capturedBytes = [Text.Encoding]::UTF8.GetByteCount($controllerStdout) + [Text.Encoding]::UTF8.GetByteCount($controllerStderr)
        if ($capturedBytes -gt $MaxCapturedOutputBytes) {
            throw "Component action exceeded the $MaxCapturedOutputBytes byte output limit; inspect the component-owned runtime log."
        }
        return [pscustomobject]@{
            processId = $process.Id
            exitCode = $controllerExitCode
            stdout = $controllerStdout
        }
    }
    finally {
        if ($null -ne $resultReader) { $resultReader.Dispose() }
        if ($null -ne $resultPipe) { $resultPipe.Dispose() }
        if ($null -ne $process) { $process.Dispose() }
    }
}

function Assert-McpCcControllerActionResult {
    param(
        [Parameter(Mandatory = $true)]$Document,
        [Parameter(Mandatory = $true)][string]$ExpectedAction
    )
    foreach ($name in @("ok", "action", "before", "after", "ownedPids", "elapsedMs", "errorCode", "message")) {
        if (-not (Get-McpCcObjectProperty -Object $Document -Name $name).found) {
            throw "Component controller result is missing required field '$name'."
        }
    }
    if ($Document.ok -isnot [bool]) {
        throw "Component controller result field 'ok' must be boolean."
    }
    if (-not ([string]$Document.action).Equals($ExpectedAction, [StringComparison]::Ordinal)) {
        throw "Component controller result action does not match the requested action."
    }
    $elapsed = 0L
    if (-not [long]::TryParse([string]$Document.elapsedMs, [ref]$elapsed) -or $elapsed -lt 0) {
        throw "Component controller result field 'elapsedMs' must be a non-negative integer."
    }
    if (-not [bool]$Document.ok) {
        $errorCode = [string]$Document.errorCode
        if ([string]::IsNullOrWhiteSpace($errorCode) -or $errorCode -notmatch '^[A-Z][A-Z0-9_]{0,63}$') {
            $errorCode = "CONTROLLER_REPORTED_FAILURE"
        }
        throw "Component controller reported failure '$errorCode'; inspect the component-owned runtime log."
    }
}

function Assert-McpCcComponentUiActionResult {
    param(
        [Parameter(Mandatory = $true)]$Document,
        [Parameter(Mandatory = $true)][string]$ExpectedAction
    )
    foreach ($name in @("ok", "action", "errorCode", "message")) {
        if (-not (Get-McpCcObjectProperty -Object $Document -Name $name).found) {
            throw "Component UI action result is missing required field '$name'."
        }
    }
    if ($Document.ok -isnot [bool]) { throw "Component UI action result field 'ok' must be boolean." }
    if (-not ([string]$Document.action).Equals($ExpectedAction, [StringComparison]::Ordinal)) {
        throw "Component UI action result action does not match the requested action."
    }
    if (([string]$Document.message).Length -gt 512 -or ([string]$Document.errorCode).Length -gt 80) {
        throw "Component UI action result exceeds the safe message limit."
    }
    if (-not [bool]$Document.ok) {
        $errorCode = [string]$Document.errorCode
        if ([string]::IsNullOrWhiteSpace($errorCode)) { $errorCode = "COMPONENT_UI_ACTION_FAILED" }
        throw "Component UI action reported failure '$errorCode'; inspect the component-owned UI or runtime log."
    }
}

function Invoke-McpCcComponentUiAction {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string]$ComponentId,
        [Parameter(Mandatory = $true)][ValidatePattern('^[a-z][a-z0-9_]{0,63}$')][string]$ActionId,
        [switch]$PlanOnly,
        [string]$RuntimeRoot = (Get-McpCcDefaultRuntimeRoot),
        [int]$ActionTimeoutSeconds = 0,
        [ValidateRange(1024, 1048576)][int]$MaxCapturedOutputBytes = 65536
    )
    $component = Get-McpCcComponent -Manifest $Manifest -Id $ComponentId
    if ((Get-McpCcRuntimeMode -Component $component) -ne "component-controller") {
        throw "Component '$ComponentId' UI actions require component-controller mode."
    }
    $menuContractResult = Get-McpCcObjectProperty -Object $component.ui -Name "menuContract"
    if (-not $menuContractResult.found -or [string]$menuContractResult.value -ne $script:ExpectedComponentMenuContract) {
        throw "Component '$ComponentId' does not declare '$script:ExpectedComponentMenuContract'."
    }
    $menuAction = @($component.ui.menuActions | Where-Object { [string]$_.id -eq $ActionId } | Select-Object -First 1)
    if ($menuAction.Count -ne 1) { throw "Component '$ComponentId' does not declare UI action '$ActionId'." }
    $entrypoint = Resolve-McpCcChildPath -Root $component.resolvedRoot -RelativePath ([string]$component.ui.actionEntrypoint.path) -Label "Component '$ComponentId' UI action entrypoint"
    if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
        throw "Component UI action entrypoint is missing for '$ComponentId': $entrypoint"
    }
    if ($PlanOnly) {
        return [pscustomobject]@{
            component = $ComponentId
            action = $ActionId
            menuContract = $script:ExpectedComponentMenuContract
            planned = $true
            path = $entrypoint
            arguments = @("-Action", $ActionId)
        }
    }
    $mutex = New-Object Threading.Mutex($false, "Local\McpControlCenter.Action.$ComponentId")
    $mutexAcquired = $false
    try {
        try { $mutexAcquired = $mutex.WaitOne(0, $false) }
        catch [Threading.AbandonedMutexException] { $mutexAcquired = $true }
        if (-not $mutexAcquired) { throw "Another manager action is already active for component '$ComponentId'." }
        $timeoutSeconds = if ($ActionTimeoutSeconds -gt 0) { $ActionTimeoutSeconds } else { Get-McpCcComponentTimingSeconds -Manifest $Manifest -Component $component -Name "controllerActionTimeoutSeconds" }
        $started = [Diagnostics.Stopwatch]::StartNew()
        $execution = Invoke-McpCcBoundedPowerShell `
            -ScriptPath $entrypoint `
            -Arguments @("-Action", $ActionId) `
            -WorkingDirectory $component.resolvedRoot `
            -RuntimeRoot $RuntimeRoot `
            -TimeoutSeconds $timeoutSeconds `
            -MaxCapturedOutputBytes $MaxCapturedOutputBytes
        if ($execution.exitCode -ne 0) {
            throw "Component UI action failed with exit code $($execution.exitCode). Inspect the component-owned UI or runtime log."
        }
        $outputText = ([string]$execution.stdout).Trim()
        if ([string]::IsNullOrWhiteSpace($outputText)) { throw "Component UI action returned no JSON result." }
        try { $actionResult = $outputText | ConvertFrom-Json }
        catch { throw "Component UI action returned invalid JSON." }
        Assert-McpCcComponentUiActionResult -Document $actionResult -ExpectedAction $ActionId
        $started.Stop()
        return [pscustomobject]@{
            component = $ComponentId
            action = $ActionId
            menuContract = $script:ExpectedComponentMenuContract
            planned = $false
            delegated = $true
            processId = $execution.processId
            exitCode = $execution.exitCode
            result = (ConvertTo-McpCcSafeObject -Value $actionResult)
            elapsedMs = [int]$started.ElapsedMilliseconds
        }
    }
    finally {
        if ($mutexAcquired) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Invoke-McpCcComponentAction {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string]$ComponentId,
        [ValidateSet(
            "start",
            "restart",
            "ensure_running",
            "repair_connectivity",
            "restart_core",
            "reload_runtime",
            "shutdown_runtime",
            "show_diagnostic_tray"
        )][string]$Action,
        [switch]$PlanOnly,
        [string]$RuntimeRoot = (Get-McpCcDefaultRuntimeRoot),
        [int]$ActionTimeoutSeconds = 0,
        [ValidateRange(1024, 1048576)][int]$MaxCapturedOutputBytes = 65536
    )
    $component = Get-McpCcComponent -Manifest $Manifest -Id $ComponentId
    $binding = Get-McpCcComponentActionBinding -Component $component -Action $Action
    $actionSpec = $binding.actionSpec
    $actionPath = Resolve-McpCcChildPath -Root $component.resolvedRoot -RelativePath ([string]$actionSpec.path) -Label "$($binding.semanticAction) action"
    if (-not (Test-Path -LiteralPath $actionPath -PathType Leaf)) {
        throw "Action entrypoint is missing for '$ComponentId': $actionPath"
    }
    if ($PlanOnly) {
        return [pscustomobject]@{
            component = $ComponentId
            action = $binding.semanticAction
            manifestAction = $binding.manifestAction
            runtimeMode = $binding.runtimeMode
            planned = $true
            path = $actionPath
            arguments = @($binding.standardArguments)
        }
    }
    $mutex = New-Object Threading.Mutex($false, "Local\McpControlCenter.Action.$ComponentId")
    $mutexAcquired = $false
    try {
        try { $mutexAcquired = $mutex.WaitOne(0, $false) }
        catch [Threading.AbandonedMutexException] { $mutexAcquired = $true }
        if (-not $mutexAcquired) {
            throw "Another manager action is already active for component '$ComponentId'."
        }
        $started = [Diagnostics.Stopwatch]::StartNew()
        $pid = $null
        $exitCode = $null
        $actionResult = $null
        if ([string]$actionSpec.kind -eq "vbs") {
            $wscript = Join-Path $env:WINDIR "System32\wscript.exe"
            $process = Start-Process -FilePath $wscript -ArgumentList "`"$actionPath`"" -WorkingDirectory $component.resolvedRoot -WindowStyle Hidden -PassThru
            $pid = $process.Id
        }
        elseif ([string]$actionSpec.kind -eq "powershell") {
            $arguments = @()
            if ($binding.runtimeMode -eq "component-controller") {
                $arguments += @($binding.standardArguments)
            }
            else {
                $specArguments = Get-McpCcObjectProperty -Object $actionSpec -Name "arguments"
                if ($specArguments.found) { $arguments += @($specArguments.value | ForEach-Object { [string]$_ }) }
            }
            $timeoutSeconds = if ($ActionTimeoutSeconds -gt 0) { $ActionTimeoutSeconds } else { Get-McpCcComponentTimingSeconds -Manifest $Manifest -Component $component -Name "controllerActionTimeoutSeconds" }
            $execution = Invoke-McpCcBoundedPowerShell -ScriptPath $actionPath -Arguments $arguments -WorkingDirectory $component.resolvedRoot -RuntimeRoot $RuntimeRoot -TimeoutSeconds $timeoutSeconds -MaxCapturedOutputBytes $MaxCapturedOutputBytes
            $pid = $execution.processId
            $exitCode = $execution.exitCode
            $outputText = ([string]$execution.stdout).Trim()
            if ($binding.runtimeMode -eq "component-controller") {
                if ([string]::IsNullOrWhiteSpace($outputText)) {
                    if ($exitCode -ne 0) {
                        throw "Component action failed with exit code $exitCode. See the component-owned runtime log for details."
                    }
                    throw "Component controller returned no JSON result."
                }
                try { $actionResult = $outputText | ConvertFrom-Json }
                catch { throw "Component controller returned invalid JSON; inspect the component-owned runtime log." }
                $expectedControllerAction = [string]@($binding.standardArguments)[1]
                Assert-McpCcControllerActionResult -Document $actionResult -ExpectedAction $expectedControllerAction
                if ($exitCode -ne 0) {
                    throw "Component controller returned success JSON with nonzero exit code; inspect the component-owned runtime log."
                }
                $actionResult = ConvertTo-McpCcSafeObject -Value $actionResult
            }
            else {
                if ($exitCode -ne 0) {
                    throw "Component action failed with exit code $exitCode. See the component-owned runtime log for details."
                }
                if (-not [string]::IsNullOrWhiteSpace($outputText)) {
                    try { $actionResult = $outputText | ConvertFrom-Json }
                    catch { $actionResult = "[non-json component output omitted]" }
                    $actionResult = ConvertTo-McpCcSafeObject -Value $actionResult
                }
            }
        }
        $started.Stop()
        return [pscustomobject]@{
            component = $ComponentId
            action = $binding.semanticAction
            manifestAction = $binding.manifestAction
            runtimeMode = $binding.runtimeMode
            planned = $false
            delegated = $true
            processId = $pid
            exitCode = $exitCode
            result = $actionResult
            elapsedMs = [int]$started.ElapsedMilliseconds
        }
    }
    finally {
        if ($mutexAcquired) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Get-McpCcControllerAudit {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [string]$RuntimeRoot = (Get-McpCcDefaultRuntimeRoot),
        [scriptblock]$StatusInvoker
    )
    $runtimeRootPath = Assert-McpCcSafeRuntimeRoot -RuntimeRoot $RuntimeRoot
    $entries = @()
    foreach ($component in @($Manifest.components | Sort-Object startupOrder)) {
        $started = [Diagnostics.Stopwatch]::StartNew()
        try {
            if ((Get-McpCcRuntimeMode -Component $component) -ne "component-controller") {
                throw "The component is not using the v3 controller contract."
            }
            if ($null -ne $StatusInvoker) {
                $document = & $StatusInvoker $component $runtimeRootPath
            }
            else {
                $timeoutSeconds = Get-McpCcComponentTimingSeconds -Manifest $Manifest -Component $component -Name "controllerActionTimeoutSeconds"
                $execution = Invoke-McpCcBoundedPowerShell `
                    -ScriptPath $component.resolvedContractScript `
                    -Arguments @("-Action", "Status") `
                    -WorkingDirectory $component.resolvedRoot `
                    -RuntimeRoot $runtimeRootPath `
                    -TimeoutSeconds $timeoutSeconds `
                    -MaxCapturedOutputBytes 65536
                if ($execution.exitCode -ne 0) {
                    throw "The component controller status action exited with code $($execution.exitCode)."
                }
                $outputText = ([string]$execution.stdout).Trim()
                if ([string]::IsNullOrWhiteSpace($outputText)) {
                    throw "The component controller returned no status document."
                }
                try { $document = $outputText | ConvertFrom-Json }
                catch { throw "The component controller returned an invalid status document." }
            }
            foreach ($field in @("ok", "action", "after", "elapsedMs", "errorCode", "message")) {
                if (-not (Get-McpCcObjectProperty -Object $document -Name $field).found) {
                    throw "The component controller status document is missing '$field'."
                }
            }
            if ($document.ok -isnot [bool] -or -not [bool]$document.ok) {
                throw "The component controller did not complete its status action."
            }
            if (-not ([string]$document.action).Equals("Status", [StringComparison]::Ordinal)) {
                throw "The component controller returned the wrong action identity."
            }
            $statusProperty = Get-McpCcObjectProperty -Object $document.after -Name "status"
            if (-not $statusProperty.found -or [string]::IsNullOrWhiteSpace([string]$statusProperty.value)) {
                throw "The component controller status document has no runtime status."
            }
            $status = [string]$statusProperty.value
            $knownStatuses = @("Ready", "Degraded", "BlockedUpstream", "Stopped", "Unhealthy", "OwnershipMismatch")
            if ($status -notin $knownStatuses) {
                throw "The component controller returned an unknown runtime status."
            }
            $started.Stop()
            $entries += [pscustomobject]@{
                component = [string]$component.id
                status = $status
                manageable = ($status -ne "OwnershipMismatch")
                errorCode = $null
                elapsedMs = [int]$started.ElapsedMilliseconds
            }
        }
        catch {
            $started.Stop()
            $entries += [pscustomobject]@{
                component = [string]$component.id
                status = "ControllerError"
                manageable = $false
                errorCode = "CONTROLLER_STATUS_FAILED"
                elapsedMs = [int]$started.ElapsedMilliseconds
            }
        }
    }
    return [pscustomobject]@{
        entries = $entries
        manageableCount = @($entries | Where-Object { $_.manageable }).Count
        unmanageableCount = @($entries | Where-Object { -not $_.manageable }).Count
    }
}

function Get-McpCcAutomaticRepairDecision {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)]$Component,
        [Parameter(Mandatory = $true)]$ComponentStatus
    )

    $managerAttemptLimit = 1
    $result = [ordered]@{
        allowed = $false
        decision = "ManualAttention"
        action = $null
        classification = "NotEligible"
        errorCode = "REPAIR_STATUS_NOT_ELIGIBLE"
        managerAttemptLimit = $managerAttemptLimit
        retryOwner = "component_controller"
        controllerTimeoutSeconds = 0
    }
    if ([string]$ComponentStatus.status -ne "Degraded") { return [pscustomobject]$result }

    $capabilities = @($Component.capabilities | ForEach-Object { [string]$_ })
    if ("repair_connectivity" -notin $capabilities) {
        $result.classification = "Unsupported"
        $result.errorCode = "REPAIR_CAPABILITY_MISSING"
        return [pscustomobject]$result
    }

    $issues = @(if ($null -ne $ComponentStatus.PSObject.Properties["issues"]) { $ComponentStatus.issues } else { @() })
    $blockedCodes = @(
        "MONITOR_EXCEPTION", "OWNERSHIP_MISMATCH", "MISCONFIGURED", "NOT_INSTALLED",
        "ACTIVE_WORK_PRESENT", "ACTION_BUSY", "TUNNEL_KEY_MISSING", "TUNNEL_PROFILE_MISSING",
        "TUNNEL_PROFILE_INVALID", "TUNNEL_ID_MISSING", "TUNNEL_ID_INVALID", "TUNNEL_ID_MISMATCH",
        "TUNNEL_CONFIG_MISSING"
    )
    $blockedIssue = @($issues | Where-Object { [string]$_.code -in $blockedCodes } | Select-Object -First 1)
    if ($blockedIssue.Count -gt 0) {
        $result.classification = "Blocked"
        $result.errorCode = [string]$blockedIssue[0].code
        return [pscustomobject]$result
    }

    $connectivityResult = Get-McpCcObjectProperty -Object $ComponentStatus -Name "connectivity"
    if (-not $connectivityResult.found -or $null -eq $connectivityResult.value) {
        $result.classification = "InsufficientEvidence"
        $result.errorCode = "REPAIR_EVIDENCE_INSUFFICIENT"
        return [pscustomobject]$result
    }
    $connectivity = $connectivityResult.value
    foreach ($remoteName in @("remoteRegistration", "chatgptConnector")) {
        $remoteResult = Get-McpCcObjectProperty -Object $connectivity -Name $remoteName
        if ($remoteResult.found -and $null -ne $remoteResult.value -and [string]$remoteResult.value.status -eq "Failed") {
            $result.classification = "RemoteFailure"
            $result.errorCode = "REMOTE_REPAIR_NOT_ALLOWED"
            return [pscustomobject]$result
        }
    }

    $localStatusResult = Get-McpCcObjectProperty -Object $ComponentStatus -Name "localStatus"
    if (-not $localStatusResult.found -or [string]$localStatusResult.value -ne "Degraded") {
        $result.classification = "NonLocalFailure"
        $result.errorCode = "REMOTE_REPAIR_NOT_ALLOWED"
        return [pscustomobject]$result
    }
    $localTunnelResult = Get-McpCcObjectProperty -Object $connectivity -Name "localTunnel"
    if (-not $localTunnelResult.found -or $null -eq $localTunnelResult.value -or [string]$localTunnelResult.value.status -ne "Failed") {
        $result.classification = "InsufficientEvidence"
        $result.errorCode = "REPAIR_EVIDENCE_INSUFFICIENT"
        return [pscustomobject]$result
    }
    $transientCodes = @("HTTP_ERROR", "TIMEOUT", "EXPECTED_MISMATCH", "TUNNEL_NOT_READY")
    if ([string]$localTunnelResult.value.errorCode -notin $transientCodes) {
        $result.classification = "NonTransientLocalFailure"
        $result.errorCode = "LOCAL_FAILURE_NOT_TRANSIENT"
        return [pscustomobject]$result
    }

    $probes = @(if ($null -ne $ComponentStatus.PSObject.Properties["probes"]) { $ComponentStatus.probes } else { @() })
    $coreProbes = @($probes | Where-Object { [string]$_.role -eq "core" -and [bool]$_.required })
    if ($coreProbes.Count -eq 0 -or @($coreProbes | Where-Object { -not [bool]$_.success }).Count -gt 0) {
        $result.classification = "CoreNotReady"
        $result.errorCode = "CORE_NOT_READY"
        return [pscustomobject]$result
    }
    $ownershipMismatch = @($probes | Where-Object { $_.owner.known -and $_.owner.matchesExpected -eq $false }).Count -gt 0
    if ($ownershipMismatch) {
        $result.classification = "OwnershipFailure"
        $result.errorCode = "OWNERSHIP_MISMATCH"
        return [pscustomobject]$result
    }
    $openFailedTunnel = @($probes | Where-Object { [string]$_.role -eq "connectivity" -and -not [bool]$_.success -and [bool]$_.tcpOpen })
    if (@($openFailedTunnel | Where-Object { -not [bool]$_.owner.known -or $_.owner.matchesExpected -ne $true }).Count -gt 0) {
        $result.classification = "OwnershipUnverified"
        $result.errorCode = "OWNERSHIP_UNVERIFIED"
        return [pscustomobject]$result
    }

    $result.allowed = $true
    $result.decision = "RepairConnectivity"
    $result.action = "repair_connectivity"
    $result.classification = "LocalTransientConnectivity"
    $result.errorCode = $null
    $result.controllerTimeoutSeconds = Get-McpCcComponentTimingSeconds -Manifest $Manifest -Component $Component -Name "controllerActionTimeoutSeconds"
    return [pscustomobject]$result
}

function Get-McpCcReconcilePlan {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)]$State
    )
    $items = @()
    foreach ($component in @($Manifest.components | Sort-Object startupOrder)) {
        $status = @($State.components | Where-Object { $_.id -eq $component.id } | Select-Object -First 1)[0]
        $repairDecision = Get-McpCcAutomaticRepairDecision -Manifest $Manifest -Component $component -ComponentStatus $status
        $decision = if (-not [bool]$component.autoStart) { "SkipDisabled" }
        elseif ($status.status -eq "Stopped") { "Start" }
        elseif ($status.status -eq "Ready") { "NoAction" }
        elseif ($status.status -eq "BlockedUpstream") { "WaitForDependency" }
        elseif ($repairDecision.allowed) { "RepairConnectivity" }
        else { "ManualAttention" }
        $items += [pscustomobject]@{
            component = [string]$component.id
            displayName = [string]$component.displayName
            currentStatus = [string]$status.status
            decision = $decision
            classification = if ($decision -eq "RepairConnectivity" -or $status.status -eq "Degraded") { [string]$repairDecision.classification } else { $null }
            reasonCode = if ($decision -eq "ManualAttention" -and $status.status -eq "Degraded") { [string]$repairDecision.errorCode } else { $null }
            managerAttemptLimit = if ($decision -eq "RepairConnectivity") { [int]$repairDecision.managerAttemptLimit } else { 0 }
            retryOwner = if ($decision -eq "RepairConnectivity") { [string]$repairDecision.retryOwner } else { $null }
            controllerTimeoutSeconds = if ($decision -eq "RepairConnectivity") { [int]$repairDecision.controllerTimeoutSeconds } else { 0 }
        }
    }
    return $items
}

function Invoke-McpCcReconcileItems {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Plan,
        [Parameter(Mandatory = $true)][scriptblock]$ItemExecutor,
        [scriptblock]$FailureObserver
    )

    $actions = @()
    foreach ($item in @($Plan)) {
        $componentId = [string]$item.component
        try {
            $results = @(& $ItemExecutor $item)
            if ($results.Count -ne 1 -or $null -eq $results[0]) {
                throw "RECONCILE_COMPONENT_FAILED: Reconcile executor must return exactly one action result."
            }
            $result = $results[0]
            $resultComponent = Get-McpCcObjectProperty -Object $result -Name "component"
            if (-not $resultComponent.found -or -not ([string]$resultComponent.value).Equals($componentId, [StringComparison]::Ordinal)) {
                throw "RECONCILE_COMPONENT_FAILED: Reconcile executor returned a mismatched component result."
            }
            $actions += $result
        }
        catch {
            $rawMessage = ([string]$_.Exception.Message -replace '[\r\n]+', ' ').Trim()
            $errorCode = Get-McpCcActionErrorCode -Message $rawMessage
            if ($errorCode -eq "MANAGER_ACTION_FAILED") { $errorCode = "RECONCILE_COMPONENT_FAILED" }
            $before = if ($null -ne $item.PSObject.Properties["currentStatus"]) { [string]$item.currentStatus } else { "Unknown" }
            $failure = [pscustomobject]@{
                component = $componentId
                action = "Failed"
                before = $before
                after = "Unknown"
                ok = $false
                errorCode = $errorCode
                message = Get-McpCcSafeActionMessage -Ok $false -ErrorCode $errorCode
            }
            $actions += $failure
            if ($null -ne $FailureObserver) {
                try { & $FailureObserver $item $failure | Out-Null }
                catch { }
            }
        }
    }
    return $actions
}

function Test-McpCcShortcutMatches {
    param(
        [Parameter(Mandatory = $true)][string]$TargetPath,
        [Parameter(Mandatory = $true)][string]$Arguments,
        [Parameter(Mandatory = $true)][string]$ExpectedLauncher
    )
    $expectedWscript = Join-Path $env:WINDIR "System32\wscript.exe"
    if (-not ([IO.Path]::GetFullPath($TargetPath).Equals([IO.Path]::GetFullPath($expectedWscript), [StringComparison]::OrdinalIgnoreCase))) {
        return $false
    }
    $actualLauncher = $Arguments.Trim().Trim('"')
    return [IO.Path]::GetFullPath($actualLauncher).Equals([IO.Path]::GetFullPath($ExpectedLauncher), [StringComparison]::OrdinalIgnoreCase)
}

function Get-McpCcStartupAudit {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [string]$StartupDirectory = [Environment]::GetFolderPath("Startup")
    )
    if ([string]::IsNullOrWhiteSpace($StartupDirectory) -or -not (Test-Path -LiteralPath $StartupDirectory -PathType Container)) {
        throw "Could not resolve the current user's Startup folder."
    }
    $shell = New-Object -ComObject WScript.Shell
    $entries = @()
    foreach ($component in @($Manifest.components | Sort-Object startupOrder)) {
        $legacy = $component.legacyStartup
        if ($null -eq $legacy) { continue }
        $shortcutPath = Join-Path $StartupDirectory ([string]$legacy.shortcutName)
        $launcher = Resolve-McpCcChildPath -Root $component.resolvedRoot -RelativePath ([string]$legacy.launcher) -Label "legacy startup launcher"
        if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) {
            $entries += [pscustomobject]@{ component = $component.id; shortcutName = $legacy.shortcutName; path = $shortcutPath; status = "Missing"; expectedLauncher = $launcher }
            continue
        }
        try {
            $shortcut = $shell.CreateShortcut($shortcutPath)
            $matches = Test-McpCcShortcutMatches -TargetPath $shortcut.TargetPath -Arguments $shortcut.Arguments -ExpectedLauncher $launcher
            $entries += [pscustomobject]@{
                component = $component.id
                shortcutName = $legacy.shortcutName
                path = $shortcutPath
                status = if ($matches) { "Recognized" } else { "Conflict" }
                expectedLauncher = $launcher
            }
        }
        catch {
            $entries += [pscustomobject]@{ component = $component.id; shortcutName = $legacy.shortcutName; path = $shortcutPath; status = "Conflict"; expectedLauncher = $launcher }
        }
    }
    return [pscustomobject]@{
        startupDirectory = $StartupDirectory
        entries = $entries
        recognizedCount = @($entries | Where-Object { $_.status -eq "Recognized" }).Count
        conflictCount = @($entries | Where-Object { $_.status -eq "Conflict" }).Count
        missingCount = @($entries | Where-Object { $_.status -eq "Missing" }).Count
    }
}

Export-ModuleMember -Function @(
    "Get-McpCcDefaultManifestPath",
    "Get-McpCcDefaultRuntimeRoot",
    "Get-McpCcBootId",
    "Test-McpCcPathWithinRoot",
    "Resolve-McpCcChildPath",
    "Assert-McpCcLoopbackUrl",
    "Test-McpCcCommandLineContains",
    "ConvertFrom-McpCcDynamicPortRangeText",
    "ConvertFrom-McpCcExcludedPortRangeText",
    "Get-McpCcWindowsTcpPortPolicy",
    "Test-McpCcPortAgainstPolicy",
    "ConvertTo-McpCcPortPolicySummary",
    "Get-McpCcProcessLineage",
    "Read-McpCcManifest",
    "Read-McpCcComponentCandidate",
    "Get-McpCcComponent",
    "Get-McpCcComponentTimingSeconds",
    "Get-McpCcProbeResult",
    "Resolve-McpCcComponentState",
    "Get-McpCcRunningAcceptanceStates",
    "Get-McpCcStatusPresentation",
    "Get-McpCcRestartMcpDecision",
    "Get-McpCcAutomaticRepairDecision",
    "Get-McpCcActionErrorCode",
    "Get-McpCcSafeActionMessage",
    "ConvertTo-McpCcRemoteConnectivityEvidence",
    "New-McpCcConnectivityDetail",
    "Read-McpCcRemoteEvidenceFile",
    "Resolve-McpCcStatusWithConnectivity",
    "Get-McpCcReadinessScope",
    "Write-McpCcLastActionResult",
    "Read-McpCcLastActionResult",
    "Get-McpCcTrayComponentModel",
    "Get-McpCcComponentHealthModel",
    "Get-McpCcComponentStatus",
    "New-McpCcMonitorExceptionStatus",
    "Get-McpCcSystemState",
    "ConvertTo-McpCcSafeObject",
    "Write-McpCcJsonAtomic",
    "Write-McpCcEvent",
    "Read-McpCcState",
    "Publish-McpCcState",
    "Test-McpCcComponentContract",
    "Test-McpCcManifest",
    "Invoke-McpCcComponentAction",
    "Invoke-McpCcComponentUiAction",
    "Get-McpCcControllerAudit",
    "Get-McpCcReconcilePlan",
    "Invoke-McpCcReconcileItems",
    "Test-McpCcShortcutMatches",
    "Get-McpCcStartupAudit"
)
