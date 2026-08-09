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
        -Allowed @("schemaVersion", "id", "displayName", "runtimeMode", "runtimeContract", "traits", "contractScript", "capabilities", "lifecycle", "legacyStartup", "timing", "probes", "navigation", "ui", "safety") `
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
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds
    )
    $started = [Diagnostics.Stopwatch]::StartNew()
    $success = $false
    $errorCode = $null
    $errorMessage = $null
    $summary = [ordered]@{}
    try {
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

    $tcpOpen = if ($success) { $true } else { Test-McpCcTcpPort -Port ([int]$Probe.port) }
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

function Get-McpCcComponentStatus {
    param(
        [Parameter(Mandatory = $true)]$Component,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds
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
            $probeResults += Get-McpCcProbeResult -Probe $probe -TimeoutSeconds $TimeoutSeconds
        }
    }
    $status = Resolve-McpCcComponentState -Component $Component -RootExists $rootExists -StartActionExists $startExists -ProbeResults $probeResults
    $issues = @($probeResults | Where-Object { -not $_.success } | ForEach-Object {
        [pscustomobject]@{ probe = $_.id; code = $_.errorCode; message = $_.error }
    })
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
        checkedAt = [DateTime]::UtcNow.ToString("o")
        elapsedMs = [int]$started.ElapsedMilliseconds
        rootExists = $rootExists
        startActionExists = $startExists
        healthUrl = if ($primaryProbe.Count -gt 0) { [string]$primaryProbe[0].url } else { $null }
        probes = $probeResults
        issues = $issues
    }
}

function Get-McpCcSystemState {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [string]$BootId = (Get-McpCcBootId)
    )
    $components = @()
    foreach ($component in @($Manifest.components | Sort-Object startupOrder)) {
        $components += Get-McpCcComponentStatus -Component $component -TimeoutSeconds ([int]$Manifest.settings.probeTimeoutSeconds)
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
    $captureId = "${PID}-$([Guid]::NewGuid().ToString('N'))"
    $stdoutPath = Join-Path $captureRoot "$captureId.stdout"
    $stderrPath = Join-Path $captureRoot "$captureId.stderr"
    $process = $null
    $stdoutStream = $null
    $stderrStream = $null
    $stdoutTask = $null
    $stderrTask = $null
    try {
        $processArguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ScriptPath) + @($Arguments)
        $argumentLine = (@($processArguments | ForEach-Object { ConvertTo-McpCcWindowsArgument -Value ([string]$_) }) -join " ")
        $startInfo = New-Object Diagnostics.ProcessStartInfo
        $startInfo.FileName = Join-Path $PSHOME "powershell.exe"
        $startInfo.Arguments = $argumentLine
        $startInfo.WorkingDirectory = $WorkingDirectory
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $process = New-Object Diagnostics.Process
        $process.StartInfo = $startInfo
        if (-not $process.Start()) { throw "Unable to start the component lifecycle controller." }
        $stdoutStream = New-Object IO.FileStream($stdoutPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        $stderrStream = New-Object IO.FileStream($stderrPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        $stdoutTask = $process.StandardOutput.BaseStream.CopyToAsync($stdoutStream)
        $stderrTask = $process.StandardError.BaseStream.CopyToAsync($stderrStream)
        $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
        while (-not $process.WaitForExit(100)) {
            $capturedBytes = $stdoutStream.Length + $stderrStream.Length
            if ($capturedBytes -gt $MaxCapturedOutputBytes) {
                Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
                $null = $process.WaitForExit(5000)
                throw "Component action exceeded the $MaxCapturedOutputBytes byte output limit; inspect the component-owned runtime log."
            }
            if ([DateTime]::UtcNow -ge $deadline) {
                Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
                $null = $process.WaitForExit(5000)
                throw "Component action timed out after $TimeoutSeconds seconds; status must be checked before retrying."
            }
        }
        $process.WaitForExit()
        if ($null -ne $stdoutTask -and -not $stdoutTask.Wait(5000)) { throw "Timed out draining component controller stdout." }
        if ($null -ne $stderrTask -and -not $stderrTask.Wait(5000)) { throw "Timed out draining component controller stderr." }
        $stdoutStream.Flush()
        $stderrStream.Flush()
        $capturedBytes = $stdoutStream.Length + $stderrStream.Length
        if ($capturedBytes -gt $MaxCapturedOutputBytes) {
            throw "Component action exceeded the $MaxCapturedOutputBytes byte output limit; inspect the component-owned runtime log."
        }
        $stdoutStream.Dispose()
        $stdoutStream = $null
        $stderrStream.Dispose()
        $stderrStream = $null
        return [pscustomobject]@{
            processId = $process.Id
            exitCode = $process.ExitCode
            stdout = (Read-McpCcCapturedText -Path $stdoutPath)
        }
    }
    finally {
        if ($null -ne $stdoutStream) { $stdoutStream.Dispose() }
        if ($null -ne $stderrStream) { $stderrStream.Dispose() }
        foreach ($path in @($stdoutPath, $stderrPath)) {
            if (Test-Path -LiteralPath $path -PathType Leaf) {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
        }
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
        if ([string]::IsNullOrWhiteSpace($errorCode)) { $errorCode = "CONTROLLER_REPORTED_FAILURE" }
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
            if ($exitCode -ne 0) {
                throw "Component action failed with exit code $exitCode. See the component-owned runtime log for details."
            }
            $outputText = ([string]$execution.stdout).Trim()
            if ($binding.runtimeMode -eq "component-controller") {
                if ([string]::IsNullOrWhiteSpace($outputText)) {
                    throw "Component controller returned no JSON result."
                }
                try { $actionResult = $outputText | ConvertFrom-Json }
                catch { throw "Component controller returned invalid JSON; inspect the component-owned runtime log." }
                $expectedControllerAction = [string]@($binding.standardArguments)[1]
                Assert-McpCcControllerActionResult -Document $actionResult -ExpectedAction $expectedControllerAction
                $actionResult = ConvertTo-McpCcSafeObject -Value $actionResult
            }
            elseif (-not [string]::IsNullOrWhiteSpace($outputText)) {
                try { $actionResult = $outputText | ConvertFrom-Json }
                catch { $actionResult = "[non-json component output omitted]" }
                $actionResult = ConvertTo-McpCcSafeObject -Value $actionResult
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

function Get-McpCcReconcilePlan {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)]$State
    )
    $items = @()
    foreach ($component in @($Manifest.components | Sort-Object startupOrder)) {
        $status = @($State.components | Where-Object { $_.id -eq $component.id } | Select-Object -First 1)[0]
        $decision = if (-not [bool]$component.autoStart) { "SkipDisabled" }
        elseif ($status.status -eq "Stopped") { "Start" }
        elseif ($status.status -eq "Ready") { "NoAction" }
        elseif ($status.status -eq "BlockedUpstream") { "WaitForDependency" }
        else { "ManualAttention" }
        $items += [pscustomobject]@{
            component = [string]$component.id
            displayName = [string]$component.displayName
            currentStatus = [string]$status.status
            decision = $decision
        }
    }
    return $items
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
    "Get-McpCcProcessLineage",
    "Read-McpCcManifest",
    "Read-McpCcComponentCandidate",
    "Get-McpCcComponent",
    "Get-McpCcComponentTimingSeconds",
    "Get-McpCcProbeResult",
    "Resolve-McpCcComponentState",
    "Get-McpCcRunningAcceptanceStates",
    "Get-McpCcComponentStatus",
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
    "Test-McpCcShortcutMatches",
    "Get-McpCcStartupAudit"
)
