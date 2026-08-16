param(
    [string]$ManifestPath,
    [string]$RuntimeRoot,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-z][a-z0-9_]{0,63}$')][string]$Component,
    [switch]$SelfTest,
    [switch]$SmokeTest
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$modulePath = Join-Path $projectRoot "src\McpControlCenter.Core.psm1"
$controllerPath = Join-Path $PSScriptRoot "control-center.ps1"
Import-Module $modulePath -Force

if ([string]::IsNullOrWhiteSpace($ManifestPath)) { $ManifestPath = Get-McpCcDefaultManifestPath }
if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) { $RuntimeRoot = Get-McpCcDefaultRuntimeRoot }
$manifest = Read-McpCcManifest -Path $ManifestPath
if (Test-McpCcPathWithinRoot -Path $RuntimeRoot -Root $manifest.workspaceRoot) {
    throw "RuntimeRoot must be outside the source workspace."
}
$definition = Get-McpCcComponent -Manifest $manifest -Id $Component
$uiProperty = $definition.PSObject.Properties["ui"]
$declaredActionIds = if ($null -ne $uiProperty -and $null -ne $uiProperty.Value) {
    $menuActionsProperty = $uiProperty.Value.PSObject.Properties["menuActions"]
    if ($null -ne $menuActionsProperty) { @($menuActionsProperty.Value | ForEach-Object { [string]$_.id }) } else { @() }
}
else { @() }
$script:AllowedAdapterActions = @(
    "copy_mcp_url",
    "copy_health_url",
    "copy_tunnel_id",
    "open_tunnel_ui",
    "open_runtime_logs"
)

if ($SelfTest) {
    $requiredActions = @("copy_mcp_url", "copy_health_url", "open_runtime_logs")
    $missingRequired = @($requiredActions | Where-Object { $_ -notin $declaredActionIds })
    [pscustomobject]@{
        ok = (Test-Path -LiteralPath $controllerPath -PathType Leaf) -and $missingRequired.Count -eq 0
        formContract = "component-health-detail-v1"
        component = $Component
        controllerExists = Test-Path -LiteralPath $controllerPath -PathType Leaf
        managerDomainDataAccess = "none"
        managerSecretAccess = "none"
        opensListener = $false
        layoutSmokeSupported = $true
        requiredActionsPresent = $missingRequired.Count -eq 0
        availableAdapterActions = @($script:AllowedAdapterActions | Where-Object { $_ -in $declaredActionIds })
    } | ConvertTo-Json -Depth 5
    if (-not (Test-Path -LiteralPath $controllerPath -PathType Leaf) -or $missingRequired.Count -gt 0) { exit 1 }
    exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:ActionProcess = $null
$script:RefreshProcess = $null
$script:LastStateStamp = $null
$script:AdapterButtons = @()

function Quote-ProcessArgument([string]$Value) {
    if ($null -eq $Value) { return '""' }
    return '"' + $Value.Replace('"', '\"') + '"'
}

function Start-ControlCenterProcess {
    param(
        [Parameter(Mandatory = $true)][string]$Action,
        [string]$UiAction
    )

    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $controllerPath,
        "-Action", $Action,
        "-ManifestPath", $ManifestPath,
        "-RuntimeRoot", $RuntimeRoot
    )
    if ($Action -eq "ComponentMenuAction") {
        $arguments += @("-Component", $Component, "-UiAction", $UiAction)
    }
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = (Get-Command powershell.exe -ErrorAction Stop).Source
    $startInfo.Arguments = ($arguments | ForEach-Object { Quote-ProcessArgument ([string]$_) }) -join " "
    $startInfo.WorkingDirectory = $projectRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($startInfo)
    if ($null -eq $process) { throw "The Control Center subprocess did not start." }
    return $process
}

function Set-AdapterButtonsEnabled([bool]$Enabled) {
    foreach ($button in @($script:AdapterButtons)) {
        $actionId = [string]$button.Tag
        $button.Enabled = $Enabled -and $actionId -in $declaredActionIds
    }
}

function Start-AdapterAction([string]$ActionId) {
    if ($ActionId -notin $script:AllowedAdapterActions -or $ActionId -notin $declaredActionIds) {
        [Windows.Forms.MessageBox]::Show(
            "This action is not declared by the component.",
            "MCP Control Center",
            [Windows.Forms.MessageBoxButtons]::OK,
            [Windows.Forms.MessageBoxIcon]::Warning
        ) | Out-Null
        return
    }
    if ($null -ne $script:ActionProcess -and -not $script:ActionProcess.HasExited) {
        [Windows.Forms.MessageBox]::Show(
            "Another component action is still running.",
            "MCP Control Center",
            [Windows.Forms.MessageBoxButtons]::OK,
            [Windows.Forms.MessageBoxIcon]::Information
        ) | Out-Null
        return
    }
    try {
        $script:ActionProcess = Start-ControlCenterProcess -Action "ComponentMenuAction" -UiAction $ActionId
        Set-AdapterButtonsEnabled $false
        $script:LastActionLabel.Text = "Last action: $ActionId requested..."
    }
    catch {
        $script:LastActionLabel.Text = "Last action: request failed; run full diagnostics."
    }
}

function Start-StatusRefresh {
    if ($null -ne $script:RefreshProcess -and -not $script:RefreshProcess.HasExited) { return }
    try {
        $script:RefreshProcess = Start-ControlCenterProcess -Action "Status"
        $script:RefreshButton.Enabled = $false
        $script:RefreshButton.Text = "Refreshing..."
    }
    catch {
        $script:LastActionLabel.Text = "Status refresh could not start."
    }
}

function Get-CurrentHealthModel {
    $state = Read-McpCcState -RuntimeRoot $RuntimeRoot
    if ($null -eq $state) {
        $state = [pscustomobject]@{
            schemaVersion = 1
            generatedAt = $null
            components = @()
        }
    }
    $lastAction = Read-McpCcLastActionResult -RuntimeRoot $RuntimeRoot -Component $Component
    return Get-McpCcComponentHealthModel -Manifest $manifest -State $state -ComponentId $Component -LastAction $lastAction
}

function Format-LocalTimestamp($Value) {
    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return "not available" }
    try { return [DateTime]::Parse([string]$Value).ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss") }
    catch { return "not available" }
}

function Update-HealthView {
    $model = Get-CurrentHealthModel
    $script:LastStateStamp = [string]$model.generatedAt
    $script:StatusLabel.Text = "$($model.symbol) $($model.statusLabel)"
    $script:CheckedLabel.Text = "Last checked: $(Format-LocalTimestamp $model.checkedAt)  |  Probe time: $($model.elapsedMs) ms"
    $script:HealthUrlText.Text = [string]$model.healthUrl
    $localTunnelStatus = if ($null -ne $model.connectivity -and $null -ne $model.connectivity.localTunnel) {
        [string]$model.connectivity.localTunnel.status
    }
    elseif ($model.tunnelReady) { "Ready" }
    else { "Failed" }
    $script:TunnelValueLabel.Text = switch ($localTunnelStatus) {
        "Ready" { "Ready" }
        "NotChecked" { "Not checked" }
        "Unknown" { "Unknown" }
        "NotConfigured" { "Not configured" }
        "OwnershipMismatch" { "Ownership mismatch" }
        default { "Needs attention" }
    }
    $script:OpenRawButton.Enabled = -not [string]::IsNullOrWhiteSpace([string]$model.healthUrl)
    switch ([string]$model.level) {
        "Ready" { $script:StatusLabel.ForeColor = [Drawing.Color]::FromArgb(30, 120, 70) }
        "Warning" { $script:StatusLabel.ForeColor = [Drawing.Color]::FromArgb(184, 112, 0) }
        "Critical" { $script:StatusLabel.ForeColor = [Drawing.Color]::FromArgb(184, 45, 45) }
        default { $script:StatusLabel.ForeColor = [Drawing.Color]::DimGray }
    }

    $script:ProbeGrid.Rows.Clear()
    foreach ($probe in @($model.probes)) {
        $health = if ($probe.success) { "Ready" } elseif (-not [string]::IsNullOrWhiteSpace([string]$probe.errorCode)) { [string]$probe.errorCode } else { "Failed" }
        $processIdText = if ($null -ne $probe.ownerPid) { [string]$probe.ownerPid } elseif ($null -ne $probe.managedPid) { [string]$probe.managedPid } else { "" }
        $errorText = if (-not [string]::IsNullOrWhiteSpace([string]$probe.error)) { [string]$probe.error } else { "" }
        $rowIndex = $script:ProbeGrid.Rows.Add(
            [string]$probe.label,
            [string]$probe.role,
            $health,
            [string]$probe.port,
            [string]$probe.ownership,
            $processIdText,
            [string]$probe.relation,
            $errorText
        )
        if (-not $probe.success) {
            $script:ProbeGrid.Rows[$rowIndex].DefaultCellStyle.ForeColor = [Drawing.Color]::FromArgb(160, 40, 40)
        }
    }
    if (@($model.probes).Count -eq 0) {
        $monitorIssue = @($model.issues | Where-Object { [string]$_.code -eq "MONITOR_EXCEPTION" } | Select-Object -First 1)
        if ($monitorIssue.Count -eq 1) {
            $script:ProbeGrid.Rows.Add("Monitoring unavailable", "-", "MONITOR_EXCEPTION", "", "Unknown", "", "", [string]$monitorIssue[0].message) | Out-Null
        }
        else {
            $script:ProbeGrid.Rows.Add("No status published", "-", "Not checked", "", "Unknown", "", "", "Refresh status to run the first component check.") | Out-Null
        }
    }

    if ($null -eq $model.lastAction) {
        $script:LastActionLabel.Text = "Last action: none recorded for this component."
    }
    else {
        $result = if ([bool]$model.lastAction.ok) { "Completed" } else { "Blocked / failed ($([string]$model.lastAction.errorCode))" }
        $script:LastActionLabel.Text = "Last action: $([string]$model.lastAction.action) - $result - $([string]$model.lastAction.message)"
    }
}

function New-ActionButton([string]$Text, [string]$ActionId, [int]$Width = 130) {
    $button = New-Object Windows.Forms.Button
    $button.Text = $Text
    $button.Tag = $ActionId
    $button.Width = $Width
    $button.Height = 30
    $button.Margin = New-Object Windows.Forms.Padding(6, 5, 0, 5)
    $button.Enabled = $ActionId -in $declaredActionIds
    $button.add_Click(({ Start-AdapterAction -ActionId $ActionId }).GetNewClosure())
    $script:AdapterButtons += $button
    return $button
}

$form = New-Object Windows.Forms.Form
$form.Text = "$([string]$definition.displayName) - MCP Health"
$form.StartPosition = [Windows.Forms.FormStartPosition]::CenterScreen
$form.Size = New-Object Drawing.Size(1040, 760)
$form.MinimumSize = New-Object Drawing.Size(900, 640)
$form.Font = New-Object Drawing.Font("Segoe UI", 9)
$form.BackColor = [Drawing.Color]::FromArgb(248, 249, 251)

$layout = New-Object Windows.Forms.TableLayoutPanel
$layout.Dock = [Windows.Forms.DockStyle]::Fill
$layout.Padding = New-Object Windows.Forms.Padding(16)
$layout.ColumnCount = 1
$layout.RowCount = 5
$layout.RowStyles.Add((New-Object Windows.Forms.RowStyle([Windows.Forms.SizeType]::Absolute, 82))) | Out-Null
$layout.RowStyles.Add((New-Object Windows.Forms.RowStyle([Windows.Forms.SizeType]::Percent, 100))) | Out-Null
$layout.RowStyles.Add((New-Object Windows.Forms.RowStyle([Windows.Forms.SizeType]::Absolute, 148))) | Out-Null
$layout.RowStyles.Add((New-Object Windows.Forms.RowStyle([Windows.Forms.SizeType]::Absolute, 66))) | Out-Null
$layout.RowStyles.Add((New-Object Windows.Forms.RowStyle([Windows.Forms.SizeType]::Absolute, 74))) | Out-Null
$form.Controls.Add($layout) | Out-Null

$header = New-Object Windows.Forms.Panel
$header.Dock = [Windows.Forms.DockStyle]::Fill
$titleLabel = New-Object Windows.Forms.Label
$titleLabel.Text = [string]$definition.displayName
$titleLabel.Font = New-Object Drawing.Font("Segoe UI Semibold", 18)
$titleLabel.AutoSize = $true
$titleLabel.Location = New-Object Drawing.Point(0, 2)
$header.Controls.Add($titleLabel) | Out-Null
$script:StatusLabel = New-Object Windows.Forms.Label
$script:StatusLabel.Text = "? Not checked"
$script:StatusLabel.Font = New-Object Drawing.Font("Segoe UI Semibold", 11)
$script:StatusLabel.AutoSize = $true
$script:StatusLabel.Location = New-Object Drawing.Point(2, 39)
$header.Controls.Add($script:StatusLabel) | Out-Null
$script:CheckedLabel = New-Object Windows.Forms.Label
$script:CheckedLabel.Text = "Last checked: not available"
$script:CheckedLabel.AutoSize = $true
$script:CheckedLabel.ForeColor = [Drawing.Color]::DimGray
$script:CheckedLabel.Location = New-Object Drawing.Point(210, 42)
$header.Controls.Add($script:CheckedLabel) | Out-Null
$layout.Controls.Add($header, 0, 0) | Out-Null

$servicesGroup = New-Object Windows.Forms.GroupBox
$servicesGroup.Text = "Services and ownership"
$servicesGroup.Dock = [Windows.Forms.DockStyle]::Fill
$servicesGroup.Padding = New-Object Windows.Forms.Padding(10)
$script:ProbeGrid = New-Object Windows.Forms.DataGridView
$script:ProbeGrid.Dock = [Windows.Forms.DockStyle]::Fill
$script:ProbeGrid.ReadOnly = $true
$script:ProbeGrid.AllowUserToAddRows = $false
$script:ProbeGrid.AllowUserToDeleteRows = $false
$script:ProbeGrid.AllowUserToResizeRows = $false
$script:ProbeGrid.RowHeadersVisible = $false
$script:ProbeGrid.AutoSizeRowsMode = [Windows.Forms.DataGridViewAutoSizeRowsMode]::AllCells
$script:ProbeGrid.SelectionMode = [Windows.Forms.DataGridViewSelectionMode]::FullRowSelect
$script:ProbeGrid.BackgroundColor = [Drawing.Color]::White
$script:ProbeGrid.BorderStyle = [Windows.Forms.BorderStyle]::FixedSingle
$columns = @(
    @{ Name = "Service"; Width = 180 },
    @{ Name = "Role"; Width = 95 },
    @{ Name = "Health"; Width = 120 },
    @{ Name = "Port"; Width = 65 },
    @{ Name = "Ownership"; Width = 105 },
    @{ Name = "PID"; Width = 70 },
    @{ Name = "Relation"; Width = 115 },
    @{ Name = "Error"; Width = 240 }
)
foreach ($columnDefinition in $columns) {
    $column = New-Object Windows.Forms.DataGridViewTextBoxColumn
    $column.HeaderText = [string]$columnDefinition.Name
    $column.Width = [int]$columnDefinition.Width
    if ($columnDefinition.Name -eq "Error") { $column.AutoSizeMode = [Windows.Forms.DataGridViewAutoSizeColumnMode]::Fill }
    $script:ProbeGrid.Columns.Add($column) | Out-Null
}
$servicesGroup.Controls.Add($script:ProbeGrid) | Out-Null
$layout.Controls.Add($servicesGroup, 0, 1) | Out-Null

$connectionGroup = New-Object Windows.Forms.GroupBox
$connectionGroup.Text = "Connection"
$connectionGroup.Dock = [Windows.Forms.DockStyle]::Fill
$connectionTable = New-Object Windows.Forms.TableLayoutPanel
$connectionTable.Dock = [Windows.Forms.DockStyle]::Fill
$connectionTable.Padding = New-Object Windows.Forms.Padding(6)
$connectionTable.ColumnCount = 4
$connectionTable.RowCount = 3
$connectionTable.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle([Windows.Forms.SizeType]::Absolute, 92))) | Out-Null
$connectionTable.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle([Windows.Forms.SizeType]::Percent, 100))) | Out-Null
$connectionTable.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle([Windows.Forms.SizeType]::Absolute, 145))) | Out-Null
$connectionTable.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle([Windows.Forms.SizeType]::Absolute, 145))) | Out-Null
foreach ($height in @(36, 36, 36)) { $connectionTable.RowStyles.Add((New-Object Windows.Forms.RowStyle([Windows.Forms.SizeType]::Absolute, $height))) | Out-Null }
$connectionGroup.Controls.Add($connectionTable) | Out-Null

foreach ($entry in @(
    @{ Row = 0; Text = "MCP URL" },
    @{ Row = 1; Text = "Health URL" },
    @{ Row = 2; Text = "Local tunnel" }
)) {
    $label = New-Object Windows.Forms.Label
    $label.Text = [string]$entry.Text
    $label.Dock = [Windows.Forms.DockStyle]::Fill
    $label.TextAlign = [Drawing.ContentAlignment]::MiddleLeft
    $connectionTable.Controls.Add($label, 0, [int]$entry.Row) | Out-Null
}
$mcpValue = New-Object Windows.Forms.Label
$mcpValue.Text = "Component-managed; value is not read by Control Center"
$mcpValue.ForeColor = [Drawing.Color]::DimGray
$mcpValue.Dock = [Windows.Forms.DockStyle]::Fill
$mcpValue.TextAlign = [Drawing.ContentAlignment]::MiddleLeft
$connectionTable.Controls.Add($mcpValue, 1, 0) | Out-Null
$connectionTable.Controls.Add((New-ActionButton -Text "Copy MCP URL" -ActionId "copy_mcp_url"), 2, 0) | Out-Null

$script:HealthUrlText = New-Object Windows.Forms.TextBox
$script:HealthUrlText.ReadOnly = $true
$script:HealthUrlText.Dock = [Windows.Forms.DockStyle]::Fill
$script:HealthUrlText.Margin = New-Object Windows.Forms.Padding(3, 7, 3, 3)
$connectionTable.Controls.Add($script:HealthUrlText, 1, 1) | Out-Null
$connectionTable.Controls.Add((New-ActionButton -Text "Copy health URL" -ActionId "copy_health_url"), 2, 1) | Out-Null
$script:OpenRawButton = New-Object Windows.Forms.Button
$script:OpenRawButton.Text = "Open raw health"
$script:OpenRawButton.Width = 130
$script:OpenRawButton.Height = 30
$script:OpenRawButton.Margin = New-Object Windows.Forms.Padding(6, 5, 0, 5)
$script:OpenRawButton.add_Click({
    if (-not [string]::IsNullOrWhiteSpace($script:HealthUrlText.Text)) { Start-Process $script:HealthUrlText.Text | Out-Null }
})
$connectionTable.Controls.Add($script:OpenRawButton, 3, 1) | Out-Null

$script:TunnelValueLabel = New-Object Windows.Forms.Label
$script:TunnelValueLabel.Text = "Not checked"
$script:TunnelValueLabel.Dock = [Windows.Forms.DockStyle]::Fill
$script:TunnelValueLabel.TextAlign = [Drawing.ContentAlignment]::MiddleLeft
$connectionTable.Controls.Add($script:TunnelValueLabel, 1, 2) | Out-Null
$connectionTable.Controls.Add((New-ActionButton -Text "Copy tunnel ID" -ActionId "copy_tunnel_id"), 2, 2) | Out-Null
$connectionTable.Controls.Add((New-ActionButton -Text "Open tunnel UI" -ActionId "open_tunnel_ui"), 3, 2) | Out-Null
$layout.Controls.Add($connectionGroup, 0, 2) | Out-Null

$advancedGroup = New-Object Windows.Forms.GroupBox
$advancedGroup.Text = "Advanced"
$advancedGroup.Dock = [Windows.Forms.DockStyle]::Fill
$advancedFlow = New-Object Windows.Forms.FlowLayoutPanel
$advancedFlow.Dock = [Windows.Forms.DockStyle]::Fill
$advancedFlow.FlowDirection = [Windows.Forms.FlowDirection]::LeftToRight
$advancedFlow.WrapContents = $false
$advancedFlow.Padding = New-Object Windows.Forms.Padding(4)
$advancedFlow.Controls.Add((New-ActionButton -Text "Open runtime logs" -ActionId "open_runtime_logs" -Width 150)) | Out-Null
$folderButton = New-Object Windows.Forms.Button
$folderButton.Text = "Open component folder"
$folderButton.Width = 165
$folderButton.Height = 30
$folderButton.Margin = New-Object Windows.Forms.Padding(6, 5, 0, 5)
$folderButton.add_Click(({ Start-Process explorer.exe -ArgumentList "`"$([string]$definition.resolvedRoot)`"" | Out-Null }).GetNewClosure())
$advancedFlow.Controls.Add($folderButton) | Out-Null
$advancedGroup.Controls.Add($advancedFlow) | Out-Null
$layout.Controls.Add($advancedGroup, 0, 3) | Out-Null

$footer = New-Object Windows.Forms.TableLayoutPanel
$footer.Dock = [Windows.Forms.DockStyle]::Fill
$footer.ColumnCount = 2
$footer.RowCount = 1
$footer.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle([Windows.Forms.SizeType]::Percent, 100))) | Out-Null
$footer.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle([Windows.Forms.SizeType]::Absolute, 240))) | Out-Null
$script:LastActionLabel = New-Object Windows.Forms.Label
$script:LastActionLabel.Text = "Last action: none recorded for this component."
$script:LastActionLabel.Dock = [Windows.Forms.DockStyle]::Fill
$script:LastActionLabel.AutoEllipsis = $true
$script:LastActionLabel.TextAlign = [Drawing.ContentAlignment]::MiddleLeft
$footer.Controls.Add($script:LastActionLabel, 0, 0) | Out-Null
$footerButtons = New-Object Windows.Forms.FlowLayoutPanel
$footerButtons.Dock = [Windows.Forms.DockStyle]::Fill
$footerButtons.FlowDirection = [Windows.Forms.FlowDirection]::RightToLeft
$footerButtons.WrapContents = $false
$closeButton = New-Object Windows.Forms.Button
$closeButton.Text = "Close"
$closeButton.Width = 90
$closeButton.Height = 30
$closeButton.Margin = New-Object Windows.Forms.Padding(6, 18, 0, 0)
$closeButton.add_Click({ $form.Close() })
$script:RefreshButton = New-Object Windows.Forms.Button
$script:RefreshButton.Text = "Refresh status"
$script:RefreshButton.Width = 120
$script:RefreshButton.Height = 30
$script:RefreshButton.Margin = New-Object Windows.Forms.Padding(6, 18, 0, 0)
$script:RefreshButton.add_Click({ Start-StatusRefresh })
$footerButtons.Controls.Add($closeButton) | Out-Null
$footerButtons.Controls.Add($script:RefreshButton) | Out-Null
$footer.Controls.Add($footerButtons, 1, 0) | Out-Null
$layout.Controls.Add($footer, 0, 4) | Out-Null

$timer = New-Object Windows.Forms.Timer
$timer.Interval = 1000
$timer.add_Tick({
    if ($null -ne $script:ActionProcess -and $script:ActionProcess.HasExited) {
        $script:ActionProcess.Dispose()
        $script:ActionProcess = $null
        Set-AdapterButtonsEnabled $true
        Update-HealthView
    }
    if ($null -ne $script:RefreshProcess -and $script:RefreshProcess.HasExited) {
        $script:RefreshProcess.Dispose()
        $script:RefreshProcess = $null
        $script:RefreshButton.Enabled = $true
        $script:RefreshButton.Text = "Refresh status"
        Update-HealthView
    }
    else {
        $state = Read-McpCcState -RuntimeRoot $RuntimeRoot
        if ($null -ne $state -and [string]$state.generatedAt -ne $script:LastStateStamp) { Update-HealthView }
    }
})

try {
    Update-HealthView
    if ($SmokeTest) {
        [pscustomobject]@{
            ok = $true
            formContract = "component-health-detail-v1"
            component = $Component
            formWidth = $form.Width
            formHeight = $form.Height
            minimumWidth = $form.MinimumSize.Width
            minimumHeight = $form.MinimumSize.Height
            probeColumnCount = $script:ProbeGrid.Columns.Count
            emptyProbeHealth = [string]$script:ProbeGrid.Rows[0].Cells[2].Value
            adapterButtonCount = @($script:AdapterButtons).Count
            opensListener = $false
        } | ConvertTo-Json -Depth 4
        exit 0
    }
    $timer.Start()
    [Windows.Forms.Application]::Run($form)
}
finally {
    $timer.Stop()
    $timer.Dispose()
    if ($null -ne $script:ActionProcess) { $script:ActionProcess.Dispose() }
    if ($null -ne $script:RefreshProcess) { $script:RefreshProcess.Dispose() }
    $form.Dispose()
}
