param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z][a-z0-9_]{0,63}$')]
    [string]$Id,
    [Parameter(Mandatory = $true)]
    [ValidateLength(1, 80)]
    [string]$DisplayName,
    [Parameter(Mandatory = $true)]
    [ValidateRange(1024, 65535)]
    [int]$CorePort,
    [string]$WorkspaceRoot,
    [switch]$IncludeDiagnosticUi,
    [switch]$Plan,
    [switch]$Apply
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$managerRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$modulePath = Join-Path $managerRoot "src\McpControlCenter.Core.psm1"
Import-Module $modulePath -Force
if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) { $WorkspaceRoot = Split-Path -Parent $managerRoot }
$resolvedWorkspace = (Resolve-Path -LiteralPath $WorkspaceRoot -ErrorAction Stop).Path
$templateRoot = Join-Path $managerRoot "templates\component-controller"
$targetRoot = [IO.Path]::GetFullPath((Join-Path $resolvedWorkspace $Id))
if (([bool]$Plan) -eq ([bool]$Apply)) { throw "Specify exactly one of -Plan or -Apply." }
if (-not (Test-McpCcPathWithinRoot -Path $targetRoot -Root $resolvedWorkspace) -or
    -not (Split-Path -Parent $targetRoot).Equals($resolvedWorkspace, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Scaffold target must be a direct child of the workspace root."
}
if (-not (Test-Path -LiteralPath $templateRoot -PathType Container)) { throw "Component template is missing: $templateRoot" }

$baseFiles = @(
    "control-center\component.json",
    "scripts\runtime-control.ps1",
    "scripts\component-runtime.psm1",
    "scripts\control-center-ui.ps1",
    "tests\test-runtime-control.ps1",
    "docs\ControlCenterIntegration.md"
)
$optionalFiles = if ($IncludeDiagnosticUi) {
    @(
        "optional\diagnostic-ui\scripts\show-diagnostic-tray.vbs",
        "optional\diagnostic-ui\scripts\diagnostic-tray.ps1"
    )
}
else { @() }
$targetFiles = @($baseFiles | ForEach-Object { $_ }) + @($optionalFiles | ForEach-Object { $_ -replace '^optional\\diagnostic-ui\\', '' })
$targetExists = Test-Path -LiteralPath $targetRoot
$planResult = [pscustomobject]@{
    action = "New"
    apply = [bool]$Apply
    safeToApply = -not $targetExists
    workspaceRoot = $resolvedWorkspace
    targetRoot = $targetRoot
    componentId = $Id
    displayName = $DisplayName
    corePort = $CorePort
    includeDiagnosticUi = [bool]$IncludeDiagnosticUi
    files = $targetFiles
    conflict = if ($targetExists) { "target_exists" } else { $null }
    effects = @("create_source_files_only", "no_registry_change", "no_startup_change", "no_process_start")
}
if ($Plan) {
    $planResult | ConvertTo-Json -Depth 6
    exit $(if ($planResult.safeToApply) { 0 } else { 2 })
}
if (-not $planResult.safeToApply) { throw "Scaffold target already exists and will not be overwritten: $targetRoot" }

$utf8NoBom = New-Object Text.UTF8Encoding($false)
$stagingRoot = Join-Path $resolvedWorkspace (".mcp-scaffold-$Id-" + [Guid]::NewGuid().ToString("N"))
$displayNameSingleQuoted = ($DisplayName -replace '[\r\n]+', ' ').Replace("'", "''")
$displayNameMarkdown = ($DisplayName -replace '[\r\n#]+', ' ').Trim()
$optionalCapabilityText = if ($IncludeDiagnosticUi) { '"show_diagnostic_tray"' } else { '' }
$supportsDiagnosticText = if ($IncludeDiagnosticUi) { "True" } else { "False" }
try {
    [IO.Directory]::CreateDirectory($stagingRoot) | Out-Null
    $descriptorTemplatePath = Join-Path $templateRoot "control-center\component.json"
    $descriptor = [IO.File]::ReadAllText($descriptorTemplatePath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $descriptor.id = $Id
    $descriptor.displayName = $DisplayName
    $descriptor.probes[0].url = "http://127.0.0.1:$CorePort/health"
    $descriptor.probes[0].port = $CorePort
    $descriptor.probes[0].expected.service = $Id
    $descriptor.probes[0].ownership.commandContains = @($Id, "component-runtime")
    if ($IncludeDiagnosticUi) {
        $descriptor.traits = @("diagnostic-ui")
        $descriptor.capabilities = @($descriptor.capabilities) + "show_diagnostic_tray"
        $descriptor.lifecycle | Add-Member -NotePropertyName diagnosticLauncher -NotePropertyValue ([pscustomobject]@{
            kind = "vbs"
            path = "scripts\show-diagnostic-tray.vbs"
        })
    }
    $descriptorTargetPath = Join-Path $stagingRoot "control-center\component.json"
    [IO.Directory]::CreateDirectory((Split-Path -Parent $descriptorTargetPath)) | Out-Null
    [IO.File]::WriteAllText($descriptorTargetPath, ($descriptor | ConvertTo-Json -Depth 20), $utf8NoBom)

    foreach ($sourceRelativePath in @($baseFiles | Where-Object { $_ -ne "control-center\component.json" }) + $optionalFiles) {
        $targetRelativePath = $sourceRelativePath -replace '^optional\\diagnostic-ui\\', ''
        $sourcePath = Join-Path $templateRoot $sourceRelativePath
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw "Template file is missing: $sourcePath" }
        $targetPath = Join-Path $stagingRoot $targetRelativePath
        [IO.Directory]::CreateDirectory((Split-Path -Parent $targetPath)) | Out-Null
        $text = [IO.File]::ReadAllText($sourcePath, [Text.Encoding]::UTF8)
        $text = $text.Replace("__COMPONENT_ID__", $Id)
        $text = $text.Replace("__DISPLAY_NAME_PS_SINGLE__", $displayNameSingleQuoted)
        $text = $text.Replace("__DISPLAY_NAME_MARKDOWN__", $displayNameMarkdown)
        $text = $text.Replace("__CORE_PORT__", [string]$CorePort)
        $text = $text.Replace("# __OPTIONAL_DIAGNOSTIC_CAPABILITY_PS__", $optionalCapabilityText)
        $text = $text.Replace("__SUPPORTS_DIAGNOSTIC_TEXT__", $supportsDiagnosticText)
        [IO.File]::WriteAllText($targetPath, $text, $utf8NoBom)
    }
    if (Test-Path -LiteralPath $targetRoot) { throw "Scaffold target appeared during generation and will not be overwritten: $targetRoot" }
    [IO.Directory]::Move($stagingRoot, $targetRoot)
    [pscustomobject]@{
        action = "New"
        applied = $true
        componentId = $Id
        targetRoot = $targetRoot
        files = $targetFiles
        registered = $false
        enabled = $false
        autoStart = $false
        processStarted = $false
        nextStep = "Run Test-McpComponent.ps1, then implement exact-path lifecycle logic before registration."
    } | ConvertTo-Json -Depth 6
}
catch {
    $resolvedStaging = [IO.Path]::GetFullPath($stagingRoot)
    if ((Test-Path -LiteralPath $resolvedStaging) -and
        (Test-McpCcPathWithinRoot -Path $resolvedStaging -Root $resolvedWorkspace) -and
        (Split-Path -Leaf $resolvedStaging).StartsWith(".mcp-scaffold-$Id-", [StringComparison]::Ordinal)) {
        Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
    }
    throw
}
