param(
  [string]$ProjectRoot,
  [string]$HostName = "127.0.0.1",
  [int]$Port = 8797,
  [string]$OmiApiBaseUrl = "http://127.0.0.1:8400",
  [string]$Token = $env:OMI_SEARCH_MCP_HTTP_TOKEN,
  [string]$TunnelClientPath = "C:\GPT_MCPtool\project_reading\vendor\tunnel-client\tunnel-client.exe",
  [string]$TunnelProfile = "omi-search",
  [string]$TunnelId = $env:OMI_SEARCH_TUNNEL_ID,
  [string]$TunnelHealthUrl = "http://127.0.0.1:8799",
  [string]$SecretPath,
  [switch]$NoAutoStart,
  [switch]$AutoStartTunnel,
  [switch]$DiagnosticOnly,
  [switch]$ReplaceExisting,
  [switch]$SelfTest
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$TrayDisplayName = $(if ($DiagnosticOnly) { "OMI Search MCP Diagnostics" } else { "OMI Search MCP" })

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}
$ComponentDescriptorPath = Join-Path $ProjectRoot "control-center\component.json"
$V3ControllerActive = $false
if (Test-Path -LiteralPath $ComponentDescriptorPath -PathType Leaf) {
  try {
    $ComponentDescriptor = [IO.File]::ReadAllText($ComponentDescriptorPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $V3ControllerActive = [string]$ComponentDescriptor.runtimeMode -eq "component-controller"
  }
  catch { throw "Invalid OMI Search control-center descriptor." }
}
if (-not $SelfTest -and -not $DiagnosticOnly -and $V3ControllerActive) {
  [Console]::Error.WriteLine("LEGACY_TRAY_DISABLED: Use MCP Control Center or the diagnostic launcher. Restore a legacy-tray descriptor only for rollback.")
  exit 3
}
$HttpEntry = Join-Path $ProjectRoot "http_server.py"
$SourceBuildFiles = @(
  $HttpEntry,
  (Join-Path $ProjectRoot "server.py"),
  (Join-Path $ProjectRoot "public_contract_snapshot.json")
)
$McpUrl = "http://${HostName}:${Port}/mcp"
$HealthUrl = "http://${HostName}:${Port}/health"
$TunnelProfileDir = Join-Path $ProjectRoot ".tunnel-client"
$TunnelProfilePath = Join-Path $TunnelProfileDir "$TunnelProfile.yaml"
if ([string]::IsNullOrWhiteSpace($TunnelId) -and (Test-Path -LiteralPath $TunnelProfilePath)) {
  foreach ($line in (Get-Content -LiteralPath $TunnelProfilePath -Encoding UTF8)) {
    if ($line -match '^\s*tunnel_id\s*:\s*"?([^"#\s]+)') {
      $TunnelId = $matches[1]
      break
    }
  }
}
$TunnelUiUrl = "$($TunnelHealthUrl.TrimEnd('/'))/ui"
$TmpDir = Join-Path $ProjectRoot ".tmp"
$TunnelLogFile = Join-Path $TmpDir "tunnel-client.log"
$TunnelPidFile = Join-Path $TmpDir "tunnel-client.pid"
$ServerPidFile = Join-Path $TmpDir "omi-search-http-server.pid"
$TrayPidFile = Join-Path $TmpDir "omi-search-tray.pid"
$TrayLogFile = Join-Path $TmpDir "omi-search-tray.log"
$PythonPath = (Get-Command python -ErrorAction Stop).Source
$ControllerPath = Join-Path $PSScriptRoot "runtime-control.ps1"

function Get-ExpectedSourceBuildId {
  $artifactHashes = @()
  foreach ($artifact in $SourceBuildFiles) {
    if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
      return ""
    }
    $artifactHashes += (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($artifactHashes -join ""))
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha256.ComputeHash($bytes)
    return (-join ($hash | ForEach-Object { $_.ToString("x2") })).Substring(0, 16)
  }
  finally {
    $sha256.Dispose()
  }
}

function Write-TrayLog([string]$Message) {
  try {
    New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
    $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffK"
    Add-Content -LiteralPath $TrayLogFile -Value "$timestamp $Message" -Encoding utf8
  }
  catch {
    # Logging must not prevent tray startup.
  }
}

function Normalize-OmiApiBaseUrl([string]$BaseUrl) {
  $text = ([string]$BaseUrl).Trim()
  if ([string]::IsNullOrWhiteSpace($text)) {
    return $null
  }
  return $text.TrimEnd("/")
}

function Test-OmiApiBaseUrl([string]$BaseUrl) {
  $normalized = Normalize-OmiApiBaseUrl $BaseUrl
  if ([string]::IsNullOrWhiteSpace($normalized)) {
    return $false
  }

  try {
    $health = Invoke-RestMethod -UseBasicParsing -Uri "$normalized/api/system/health" -TimeoutSec 2
    return ($health.status -eq "ok" -and $health.app_name -eq "Open Market Intelligence")
  }
  catch {
    return $false
  }
}

function Get-OmiLauncherBackendUrlCandidates {
  $launcherLogRoot = "C:\project\Open Market Intelligence\logs\launcher"
  if (-not (Test-Path -LiteralPath $launcherLogRoot)) {
    return @()
  }

  $candidates = New-Object System.Collections.Generic.List[string]
  $logFiles = Get-ChildItem -LiteralPath $launcherLogRoot -Recurse -File -Filter "launcher.log" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 5

  foreach ($file in $logFiles) {
    try {
      $lines = Get-Content -Encoding UTF8 -LiteralPath $file.FullName -Tail 200 -ErrorAction Stop
    }
    catch {
      continue
    }

    for ($index = $lines.Count - 1; $index -ge 0; $index--) {
      $line = $lines[$index]
      foreach ($pattern in @(
          "selected=(http://127\.0\.0\.1:\d+)",
          "Starting backend .* on (http://127\.0\.0\.1:\d+)"
        )) {
        if ($line -match $pattern) {
          $candidate = Normalize-OmiApiBaseUrl $Matches[1]
          if (-not [string]::IsNullOrWhiteSpace($candidate) -and -not $candidates.Contains($candidate)) {
            $candidates.Add($candidate) | Out-Null
          }
        }
      }
    }
  }

  return @($candidates)
}

function Resolve-OmiApiBaseUrl([string]$PreferredBaseUrl) {
  $candidates = New-Object System.Collections.Generic.List[string]
  foreach ($candidate in @(
      (Normalize-OmiApiBaseUrl $PreferredBaseUrl),
      (Normalize-OmiApiBaseUrl $env:OMI_SEARCH_API_BASE_URL)
    )) {
    if (-not [string]::IsNullOrWhiteSpace($candidate) -and -not $candidates.Contains($candidate)) {
      $candidates.Add($candidate) | Out-Null
    }
  }

  foreach ($candidate in Get-OmiLauncherBackendUrlCandidates) {
    if (-not [string]::IsNullOrWhiteSpace($candidate) -and -not $candidates.Contains($candidate)) {
      $candidates.Add($candidate) | Out-Null
    }
  }

  foreach ($candidate in @("http://127.0.0.1:8400", "http://127.0.0.1:8560")) {
    if (-not $candidates.Contains($candidate)) {
      $candidates.Add($candidate) | Out-Null
    }
  }

  foreach ($candidate in $candidates) {
    if (Test-OmiApiBaseUrl $candidate) {
      Write-TrayLog "Resolved OMI backend URL: $candidate"
      return $candidate
    }
    Write-TrayLog "OMI backend candidate not healthy: $candidate"
  }

  $fallback = Normalize-OmiApiBaseUrl $PreferredBaseUrl
  Write-TrayLog "WARN no healthy OMI backend URL found; falling back to $fallback"
  return $fallback
}

$OmiApiBaseUrl = Resolve-OmiApiBaseUrl $OmiApiBaseUrl

trap {
  Write-TrayLog "FATAL $($_.Exception.GetType().FullName): $($_.Exception.Message)"
  Write-TrayLog "FATAL_SCRIPT_STACK $($_.ScriptStackTrace)"
  exit 1
}

. "C:\GPT_MCPtool\project_reading\scripts\key-store.ps1"
$ResolvedSecretPath = Get-ControlPlaneSecretPath -ProjectRoot $ProjectRoot -SecretPath $SecretPath

if ($SelfTest) {
  $keyStatus = Test-ControlPlaneApiKeySecret -ProjectRoot $ProjectRoot -SecretPath $ResolvedSecretPath
  [pscustomobject]@{
    trayDisplayName = $TrayDisplayName
    projectRoot = $ProjectRoot
    pythonPath = $PythonPath
    httpEntry = $HttpEntry
    httpEntryExists = Test-Path -LiteralPath $HttpEntry
    expectedSourceBuildId = Get-ExpectedSourceBuildId
    omiApiBaseUrl = $OmiApiBaseUrl
    mcpUrl = $McpUrl
    healthUrl = $HealthUrl
    tunnelClientPath = $TunnelClientPath
    tunnelClientExists = Test-Path -LiteralPath $TunnelClientPath
    tunnelProfilePath = $TunnelProfilePath
    tunnelProfileExists = Test-Path -LiteralPath $TunnelProfilePath
    tunnelIdConfigured = -not [string]::IsNullOrWhiteSpace($TunnelId)
    tunnelHealthUrl = $TunnelHealthUrl
    tunnelUiUrl = $TunnelUiUrl
    serverPidFile = $ServerPidFile
    tunnelPidFile = $TunnelPidFile
    trayPidFile = $TrayPidFile
    trayLogFile = $TrayLogFile
    secretPath = $ResolvedSecretPath
    secretExists = $keyStatus.exists
    secretDecryptable = $keyStatus.decryptable
    secretUsable = $keyStatus.usable
    trayMenuContract = "unified-always-on-v2"
    lifecycleDelegated = [bool]$DiagnosticOnly
    ownsRuntimeProcesses = -not [bool]$DiagnosticOnly
    diagnosticOnlySupported = $true
    diagnosticOnly = [bool]$DiagnosticOnly
    exitUiStopsRuntime = -not [bool]$DiagnosticOnly
    legacyRuntimeTrayBlocked = $V3ControllerActive
    controllerPath = $ControllerPath
    controllerExists = Test-Path -LiteralPath $ControllerPath -PathType Leaf
    autoStartServer = $true
    autoStartTunnel = $true
  } | ConvertTo-Json -Depth 4
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

if (-not $ReplaceExisting -and (Test-Path -LiteralPath $TrayPidFile)) {
  $existingTrayPid = 0
  $existingTrayPidText = (Get-Content -LiteralPath $TrayPidFile -Raw -ErrorAction SilentlyContinue).Trim()
  if ([int]::TryParse($existingTrayPidText, [ref]$existingTrayPid) -and $existingTrayPid -ne $PID) {
    $existingTray = Get-CimInstance Win32_Process -Filter "ProcessId=$existingTrayPid" -ErrorAction SilentlyContinue
    if (
      $null -ne $existingTray -and
      -not [string]::IsNullOrWhiteSpace([string]$existingTray.CommandLine) -and
      ([string]$existingTray.CommandLine).IndexOf($PSCommandPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
    ) {
      [System.Windows.Forms.MessageBox]::Show(
        "OMI Search MCP is already running in the system tray.",
        $TrayDisplayName,
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information
      ) | Out-Null
      exit 0
    }
  }
}

$script:ServerProcess = $null
$script:TunnelProcess = $null

function Test-HttpHealth([string]$Url) {
  try {
    $health = Invoke-RestMethod -UseBasicParsing -Uri $Url -TimeoutSec 2
    return ($health.ok -eq $true)
  }
  catch {
    return $false
  }
}

function Test-HttpReady([string]$Url) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
    if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) {
      return $false
    }

    $content = $response.Content
    if ([string]::IsNullOrWhiteSpace($content)) {
      return $true
    }

    $trimmed = $content.Trim()
    if ($trimmed -eq "ready" -or $trimmed -eq "ok") {
      return $true
    }

    try {
      $parsed = $trimmed | ConvertFrom-Json
      return ($parsed.ok -eq $true -or $parsed.ready -eq $true -or $parsed.status -eq "ready")
    }
    catch {
      return $true
    }
  }
  catch {
    return $false
  }
}

function Get-ServerHealth {
  try {
    return Invoke-RestMethod -UseBasicParsing -Uri $HealthUrl -TimeoutSec 1
  }
  catch {
    return $null
  }
}

function Test-ServerEndpoint {
  $health = Get-ServerHealth
  return ($null -ne $health -and $health.ok -eq $true -and $health.service -eq "omi-search-http-mcp")
}

function Test-ServerHealth {
  $health = Get-ServerHealth
  $expectedBuildId = Get-ExpectedSourceBuildId
  $buildIdProperty = if ($null -eq $health) { $null } else { $health.PSObject.Properties["buildId"] }
  return (
    $null -ne $health -and
    $health.ok -eq $true -and
    $health.service -eq "omi-search-http-mcp" -and
    -not [string]::IsNullOrWhiteSpace($expectedBuildId) -and
    $null -ne $buildIdProperty -and
    [string]$buildIdProperty.Value -eq $expectedBuildId
  )
}

function Test-TunnelReady {
  return Test-HttpReady "$($TunnelHealthUrl.TrimEnd('/'))/readyz"
}

function Read-PidFile([string]$Path) {
  try {
    if (-not (Test-Path -LiteralPath $Path)) {
      return $null
    }
    $text = (Get-Content -Raw -LiteralPath $Path -ErrorAction Stop).Trim()
    if ([string]::IsNullOrWhiteSpace($text)) {
      return $null
    }
    return [int]$text
  }
  catch {
    return $null
  }
}

function Remove-PidFile([string]$Path) {
  try {
    if (Test-Path -LiteralPath $Path) {
      Remove-Item -LiteralPath $Path -Force
    }
  }
  catch {
    # Best-effort cleanup only.
  }
}

function Write-PidFile([string]$Path, [int]$ProcessId) {
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    Set-Content -LiteralPath $Path -Value ([string]$ProcessId) -Encoding ascii
  }
  catch {
    # The tray can still run without pid persistence.
  }
}

function Set-ProcessEnvironmentValue($StartInfo, [string]$Name, [string]$Value) {
  if ($StartInfo.EnvironmentVariables -ne $null) {
    $StartInfo.EnvironmentVariables[$Name] = $Value
    return
  }
  if ($StartInfo.Environment -ne $null) {
    $StartInfo.Environment[$Name] = $Value
    return
  }
  Write-TrayLog "WARN no process environment collection available for $Name"
}

function Remove-ProcessEnvironmentValue($StartInfo, [string]$Name) {
  if ($StartInfo.EnvironmentVariables -ne $null) {
    $StartInfo.EnvironmentVariables.Remove($Name)
    return
  }
  if ($StartInfo.Environment -ne $null) {
    $StartInfo.Environment.Remove($Name) | Out-Null
    return
  }
  Write-TrayLog "WARN no process environment collection available to remove $Name"
}

function Clear-ProxyEnvironment($StartInfo) {
  foreach ($name in @(
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy"
    )) {
    Remove-ProcessEnvironmentValue $StartInfo $name
  }
  Set-ProcessEnvironmentValue $StartInfo "NO_PROXY" "127.0.0.1,localhost"
  Set-ProcessEnvironmentValue $StartInfo "no_proxy" "127.0.0.1,localhost"
}

function Get-RecordedProcess([string]$Path, [string[]]$AllowedNames, [string]$ExpectedCommandFragment) {
  $processId = Read-PidFile $Path
  if ($processId -eq $null) {
    return $null
  }
  try {
    $process = Get-Process -Id $processId -ErrorAction Stop
  }
  catch {
    Remove-PidFile $Path
    return $null
  }
  if ($AllowedNames -and $AllowedNames.Count -gt 0 -and ($AllowedNames -notcontains $process.ProcessName)) {
    Remove-PidFile $Path
    return $null
  }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedCommandFragment)) {
    $cimProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
    if (
      $null -eq $cimProcess -or
      [string]::IsNullOrWhiteSpace([string]$cimProcess.CommandLine) -or
      ([string]$cimProcess.CommandLine).IndexOf($ExpectedCommandFragment, [StringComparison]::OrdinalIgnoreCase) -lt 0
    ) {
      Write-TrayLog "WARN ignoring stale pid file=$Path pid=$processId because command ownership did not match $ExpectedCommandFragment"
      Remove-PidFile $Path
      return $null
    }
  }
  return $process
}

function Stop-RecordedProcess([string]$Path, [string]$Label, [string[]]$AllowedNames, [string]$ExpectedCommandFragment) {
  $process = Get-RecordedProcess $Path $AllowedNames $ExpectedCommandFragment
  if ($process -eq $null) {
    return $false
  }
  if ($process.Id -eq $PID) {
    return $false
  }
  try {
    Stop-Process -Id $process.Id -Force
    $process.WaitForExit(3000) | Out-Null
    Remove-PidFile $Path
    return $true
  }
  catch {
    Show-Warning "Could not stop $Label PID $($process.Id).`n$($_.Exception.Message)"
    return $false
  }
}

function Get-ListeningPid([int]$ListenPort) {
  try {
    $connection = Get-NetTCPConnection -State Listen -LocalPort $ListenPort -ErrorAction Stop |
      Select-Object -First 1
    if ($connection -and $connection.OwningProcess) {
      return [int]$connection.OwningProcess
    }
  }
  catch {
    # Fall back to netstat below.
  }

  try {
    $lines = & netstat -ano -p tcp 2>$null
    foreach ($line in $lines) {
      if ($line -match "^\s*TCP\s+\S+:$ListenPort\s+\S+\s+LISTENING\s+(\d+)\s*$") {
        return [int]$Matches[1]
      }
    }
  }
  catch {
    return $null
  }
  return $null
}

function Stop-ListeningProcess(
  [int]$ListenPort,
  [scriptblock]$HealthCheck,
  [string]$Label,
  [string[]]$AllowedNames
) {
  if (-not (& $HealthCheck)) {
    return $false
  }
  $processId = Get-ListeningPid $ListenPort
  if ($processId -eq $null -or $processId -eq $PID) {
    return $false
  }
  try {
    $process = Get-Process -Id $processId -ErrorAction Stop
  }
  catch {
    return $false
  }
  if ($AllowedNames -and $AllowedNames.Count -gt 0 -and ($AllowedNames -notcontains $process.ProcessName)) {
    Show-Warning "$Label is healthy on port $ListenPort, but PID $processId is $($process.ProcessName); not stopping it automatically."
    return $false
  }
  try {
    Stop-Process -Id $processId -Force
    $process.WaitForExit(3000) | Out-Null
    return $true
  }
  catch {
    Show-Warning "Could not stop $Label PID $processId on port $ListenPort.`n$($_.Exception.Message)"
    return $false
  }
}

function Test-OwnedServerRunning {
  return ($script:ServerProcess -ne $null -and -not $script:ServerProcess.HasExited)
}

function Test-OwnedTunnelRunning {
  return ($script:TunnelProcess -ne $null -and -not $script:TunnelProcess.HasExited)
}

function Set-NotifyText([string]$Text) {
  if ($Text.Length -gt 63) {
    $Text = $Text.Substring(0, 63)
  }
  $notifyIcon.Text = $Text
}

function Show-Warning([string]$Message) {
  [System.Windows.Forms.MessageBox]::Show(
    $Message,
    $TrayDisplayName,
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Warning
  ) | Out-Null
}

function Show-Error([string]$Message) {
  [System.Windows.Forms.MessageBox]::Show(
    $Message,
    $TrayDisplayName,
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
}

function Show-Info([string]$Message) {
  [System.Windows.Forms.MessageBox]::Show(
    $Message,
    $TrayDisplayName,
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information
  ) | Out-Null
}

function ConvertTo-LocalSecureString([string]$PlainText) {
  $secure = New-Object System.Security.SecureString
  foreach ($char in $PlainText.ToCharArray()) {
    $secure.AppendChar($char)
  }
  $secure.MakeReadOnly()
  return $secure
}

function Save-ControlPlaneApiKeyFromPrompt {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = "Save CONTROL_PLANE_API_KEY"
  $form.Width = 540
  $form.Height = 180
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.TopMost = $true

  $label = New-Object System.Windows.Forms.Label
  $label.Left = 12
  $label.Top = 14
  $label.Width = 500
  $label.Height = 32
  $label.Text = "Paste CONTROL_PLANE_API_KEY. It will be stored encrypted with Windows DPAPI for this user."

  $textBox = New-Object System.Windows.Forms.TextBox
  $textBox.Left = 12
  $textBox.Top = 52
  $textBox.Width = 500
  $textBox.UseSystemPasswordChar = $true

  $saveButton = New-Object System.Windows.Forms.Button
  $saveButton.Text = "Save"
  $saveButton.Left = 340
  $saveButton.Top = 92
  $saveButton.Width = 82
  $saveButton.DialogResult = [System.Windows.Forms.DialogResult]::OK

  $cancelButton = New-Object System.Windows.Forms.Button
  $cancelButton.Text = "Cancel"
  $cancelButton.Left = 430
  $cancelButton.Top = 92
  $cancelButton.Width = 82
  $cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel

  $form.Controls.Add($label) | Out-Null
  $form.Controls.Add($textBox) | Out-Null
  $form.Controls.Add($saveButton) | Out-Null
  $form.Controls.Add($cancelButton) | Out-Null
  $form.AcceptButton = $saveButton
  $form.CancelButton = $cancelButton

  $result = $form.ShowDialog()
  if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
    $form.Dispose()
    return $false
  }

  $plainText = $textBox.Text.Trim()
  $textBox.Text = ""
  $form.Dispose()

  if ([string]::IsNullOrWhiteSpace($plainText)) {
    Show-Warning "CONTROL_PLANE_API_KEY is empty."
    return $false
  }

  if (-not $plainText.StartsWith("sk-")) {
    $confirm = [System.Windows.Forms.MessageBox]::Show(
      "The value does not start with sk-. Save it anyway?",
      $TrayDisplayName,
      [System.Windows.Forms.MessageBoxButtons]::YesNo,
      [System.Windows.Forms.MessageBoxIcon]::Warning
    )
    if ($confirm -ne [System.Windows.Forms.DialogResult]::Yes) {
      return $false
    }
  }

  $secure = ConvertTo-LocalSecureString $plainText
  $plainText = $null
  try {
    Save-ControlPlaneApiKeySecret -ProjectRoot $ProjectRoot -Secret $secure -SecretPath $ResolvedSecretPath | Out-Null
    Set-ControlPlaneApiKeyEnvFromSecret -ProjectRoot $ProjectRoot -SecretPath $ResolvedSecretPath | Out-Null
    Show-Info "CONTROL_PLANE_API_KEY saved for this Windows user."
    return $true
  }
  catch {
    Show-Error "Could not save CONTROL_PLANE_API_KEY.`n$($_.Exception.Message)"
    return $false
  }
  finally {
    if ($secure -ne $null) {
      $secure.Dispose()
    }
  }
}

function Show-ControlPlaneApiKeyStatus {
  $status = Test-ControlPlaneApiKeySecret -ProjectRoot $ProjectRoot -SecretPath $ResolvedSecretPath
  Show-Info "Path: $($status.path)`nExists: $($status.exists)`nDecryptable: $($status.decryptable)`nUsable: $($status.usable)"
}

function Ensure-ControlPlaneApiKeyAvailable {
  Set-ControlPlaneApiKeyEnvFromSecret -ProjectRoot $ProjectRoot -SecretPath $ResolvedSecretPath | Out-Null
  if (-not [string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)) {
    return $true
  }

  $confirm = [System.Windows.Forms.MessageBox]::Show(
    "CONTROL_PLANE_API_KEY is not saved. Paste and save it now?",
    $TrayDisplayName,
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Warning
  )
  if ($confirm -ne [System.Windows.Forms.DialogResult]::Yes) {
    return $false
  }

  return Save-ControlPlaneApiKeyFromPrompt
}

function Start-OmiSearchServer {
  Write-TrayLog "Start-OmiSearchServer requested health=$(Test-ServerHealth) endpoint=$(Test-ServerEndpoint) owned=$(Test-OwnedServerRunning) expectedBuild=$(Get-ExpectedSourceBuildId)"
  if ((Test-OwnedServerRunning) -or (Test-ServerHealth)) {
    Write-TrayLog "Start-OmiSearchServer skipped because server already appears healthy or owned"
    return
  }
  if (Test-ServerEndpoint) {
    Show-Warning "OMI Search MCP is running an older source build on port $Port.`nUse Restart MCP server to replace and verify it."
    return
  }
  if (-not (Test-Path -LiteralPath $HttpEntry)) {
    Show-Warning "Missing $HttpEntry"
    return
  }

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $PythonPath
  $startInfo.Arguments = "-B `"$HttpEntry`" --host $HostName --port $Port"
  $startInfo.WorkingDirectory = $ProjectRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  Clear-ProxyEnvironment $startInfo
  Set-ProcessEnvironmentValue $startInfo "OMI_SEARCH_API_BASE_URL" $OmiApiBaseUrl
  Set-ProcessEnvironmentValue $startInfo "OMI_SEARCH_MCP_HTTP_HOST" $HostName
  Set-ProcessEnvironmentValue $startInfo "OMI_SEARCH_MCP_HTTP_PORT" ([string]$Port)
  if ([string]::IsNullOrWhiteSpace($Token)) {
    Remove-ProcessEnvironmentValue $startInfo "OMI_SEARCH_MCP_HTTP_TOKEN"
  }
  else {
    Set-ProcessEnvironmentValue $startInfo "OMI_SEARCH_MCP_HTTP_TOKEN" $Token
  }

  try {
    Write-TrayLog "Starting MCP HTTP server with $PythonPath $($startInfo.Arguments)"
    $script:ServerProcess = [System.Diagnostics.Process]::Start($startInfo)
    if ($script:ServerProcess -ne $null) {
      Write-PidFile $ServerPidFile $script:ServerProcess.Id
      Write-TrayLog "Started MCP HTTP server pid=$($script:ServerProcess.Id)"
    }
    $notifyIcon.ShowBalloonTip(1200, $TrayDisplayName, "Server starting on $McpUrl", [System.Windows.Forms.ToolTipIcon]::Info)
  }
  catch {
    Write-TrayLog "ERROR starting MCP HTTP server: $($_.Exception.Message)"
    Show-Error "Could not start OMI Search MCP server.`n$($_.Exception.Message)"
  }
}

function Stop-OmiSearchServer {
  Write-TrayLog "Stop-OmiSearchServer requested"
  if (Test-OwnedServerRunning) {
    try {
      $script:ServerProcess.Kill()
      $script:ServerProcess.WaitForExit(3000) | Out-Null
    }
    catch {
      # Process may have already exited.
    }
    finally {
      $script:ServerProcess = $null
      Remove-PidFile $ServerPidFile
    }
  }
  Stop-RecordedProcess $ServerPidFile "OMI_search MCP HTTP server" @("python", "python3", "pythonw") $HttpEntry | Out-Null
  Stop-ListeningProcess $Port { Test-ServerEndpoint } "OMI_search MCP HTTP server" @("python", "python3", "pythonw") | Out-Null
  if (-not (Test-ServerEndpoint)) {
    Remove-PidFile $ServerPidFile
  }
}

function Restart-OmiSearchServer {
  $previousPid = Get-ListeningPid $Port
  $expectedBuildId = Get-ExpectedSourceBuildId
  Write-TrayLog "Restart-OmiSearchServer requested previousPid=$previousPid expectedBuild=$expectedBuildId"
  Stop-OmiSearchServer
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if ($null -eq (Get-ListeningPid $Port)) {
      break
    }
    Start-Sleep -Milliseconds 200
  }
  if ($null -ne (Get-ListeningPid $Port)) {
    Write-TrayLog "ERROR restart could not release port=$Port previousPid=$previousPid"
    Show-Error "Could not restart OMI Search MCP because port $Port is still in use."
    return $false
  }
  Start-OmiSearchServer
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if (Test-ServerHealth) {
      $currentPid = Get-ListeningPid $Port
      Write-TrayLog "Restart-OmiSearchServer verified previousPid=$previousPid currentPid=$currentPid build=$expectedBuildId"
      $notifyIcon.ShowBalloonTip(
        2500,
        $TrayDisplayName,
        "MCP restarted and source build $expectedBuildId was verified. Refresh ChatGPT Actions separately if its schema still looks old.",
        [System.Windows.Forms.ToolTipIcon]::Info
      )
      return $true
    }
    Start-Sleep -Milliseconds 300
  }
  $actualHealth = Get-ServerHealth
  $actualBuildProperty = if ($null -eq $actualHealth) { $null } else { $actualHealth.PSObject.Properties["buildId"] }
  $actualBuildId = if ($null -eq $actualBuildProperty) { "unavailable" } else { [string]$actualBuildProperty.Value }
  Write-TrayLog "ERROR restart verification failed expectedBuild=$expectedBuildId actualBuild=$actualBuildId"
  Show-Error "OMI Search MCP restart could not be verified.`nExpected build: $expectedBuildId`nLoaded build: $actualBuildId"
  return $false
}

function Start-TunnelClient {
  Write-TrayLog "Start-TunnelClient requested ready=$(Test-TunnelReady) owned=$(Test-OwnedTunnelRunning)"
  if ((Test-OwnedTunnelRunning) -or (Test-TunnelReady)) {
    Write-TrayLog "Start-TunnelClient skipped because tunnel already appears ready or owned"
    return
  }
  if (-not (Test-Path -LiteralPath $TunnelClientPath)) {
    Show-Warning "Missing tunnel-client.exe at $TunnelClientPath"
    return
  }
  if (-not (Test-Path -LiteralPath $TunnelProfilePath)) {
    Show-Warning "Missing tunnel profile at $TunnelProfilePath"
    return
  }
  if (-not (Ensure-ControlPlaneApiKeyAvailable)) {
    return
  }
  if (-not (Test-ServerHealth)) {
    Start-OmiSearchServer
    Start-Sleep -Milliseconds 800
  }

  New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $TunnelClientPath
  $startInfo.Arguments = "run --profile-dir `"$TunnelProfileDir`" --profile `"$TunnelProfile`" --log.file `"$TunnelLogFile`" --pid.file `"$TunnelPidFile`""
  $startInfo.WorkingDirectory = $ProjectRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  Clear-ProxyEnvironment $startInfo
  Set-ProcessEnvironmentValue $startInfo "CONTROL_PLANE_API_KEY" $env:CONTROL_PLANE_API_KEY

  try {
    Write-TrayLog "Starting tunnel client with $TunnelClientPath $($startInfo.Arguments)"
    $script:TunnelProcess = [System.Diagnostics.Process]::Start($startInfo)
    if ($script:TunnelProcess -ne $null) {
      Write-PidFile $TunnelPidFile $script:TunnelProcess.Id
      Write-TrayLog "Started tunnel client pid=$($script:TunnelProcess.Id)"
    }
    $notifyIcon.ShowBalloonTip(1200, $TrayDisplayName, "Tunnel starting for $TunnelId", [System.Windows.Forms.ToolTipIcon]::Info)
  }
  catch {
    Write-TrayLog "ERROR starting tunnel-client: $($_.Exception.Message)"
    Show-Error "Could not start tunnel-client.`n$($_.Exception.Message)"
  }
}

function Stop-TunnelClient {
  Write-TrayLog "Stop-TunnelClient requested"
  if (Test-OwnedTunnelRunning) {
    try {
      $script:TunnelProcess.Kill()
      $script:TunnelProcess.WaitForExit(3000) | Out-Null
    }
    catch {
      # Process may have already exited.
    }
    finally {
      $script:TunnelProcess = $null
      Remove-PidFile $TunnelPidFile
    }
  }
  Stop-RecordedProcess $TunnelPidFile "OMI_search tunnel client" @("tunnel-client") $TunnelClientPath | Out-Null
  $tunnelUri = [Uri]$TunnelHealthUrl
  if ($tunnelUri.Port -gt 0) {
    Stop-ListeningProcess $tunnelUri.Port { Test-TunnelReady } "OMI_search tunnel client" @("tunnel-client") | Out-Null
  }
  if (-not (Test-TunnelReady)) {
    Remove-PidFile $TunnelPidFile
  }
}

function Copy-TextToClipboard([string]$Text) {
  [System.Windows.Forms.Clipboard]::SetText($Text)
  $notifyIcon.ShowBalloonTip(900, $TrayDisplayName, "Copied: $Text", [System.Windows.Forms.ToolTipIcon]::Info)
}

function Open-RuntimeLogs {
  New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
  Start-Process explorer.exe -ArgumentList "`"$TmpDir`""
}

function Invoke-ControllerReload {
  if (-not (Test-Path -LiteralPath $ControllerPath -PathType Leaf)) {
    Show-Error "Runtime controller is missing."
    return $false
  }
  try {
    $output = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ControllerPath -Action ReloadRuntime -ProjectRoot $ProjectRoot 2>&1)
    $exitCode = $LASTEXITCODE
    $result = ($output -join [Environment]::NewLine) | ConvertFrom-Json
    if ($exitCode -ne 0 -or $result.ok -ne $true) {
      Show-Error "Runtime reload failed.`n$($result.errorCode): $($result.message)"
      return $false
    }
    return $true
  }
  catch {
    Show-Error "Runtime reload failed. Open the component runtime log for details."
    return $false
  }
}

function Update-TrayStatus {
  $ownedRunning = Test-OwnedServerRunning
  $endpointOk = Test-ServerEndpoint
  $healthOk = Test-ServerHealth
  $tunnelOwned = Test-OwnedTunnelRunning
  $tunnelReady = Test-TunnelReady

  if ($ownedRunning -and $healthOk) {
    $serverStatus = "Running"
  }
  elseif ($ownedRunning) {
    $serverStatus = if ($endpointOk) { "Outdated" } else { "Starting" }
  }
  elseif ($healthOk) {
    $serverStatus = "Running external"
  }
  elseif ($endpointOk) {
    $serverStatus = "Outdated external"
  }
  else {
    $serverStatus = "Stopped"
  }

  if ($tunnelOwned -and $tunnelReady) {
    $tunnelStatus = "Ready"
  }
  elseif ($tunnelOwned) {
    $tunnelStatus = "Starting"
  }
  elseif ($tunnelReady) {
    $tunnelStatus = "Ready external"
  }
  else {
    $tunnelStatus = "Stopped"
  }

  if ($healthOk -and $tunnelReady) {
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
  }
  elseif ($ownedRunning -or $tunnelOwned) {
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Warning
  }
  else {
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Error
  }

  $openTunnelUiItem.Enabled = ($tunnelReady -or $tunnelOwned)
  $statusItem.Text = "$TrayDisplayName | Server: $serverStatus | Tunnel: $tunnelStatus"
  Set-NotifyText "$TrayDisplayName | $serverStatus / $tunnelStatus"
}

$contextMenu = New-Object System.Windows.Forms.ContextMenu
$statusItem = New-Object System.Windows.Forms.MenuItem "$TrayDisplayName | Server: Checking | Tunnel: Checking"
$statusItem.Enabled = $false
$restartItem = New-Object System.Windows.Forms.MenuItem $(if ($DiagnosticOnly) { "Reload managed runtime" } else { "Restart MCP server" })
$saveKeyItem = New-Object System.Windows.Forms.MenuItem "Save CONTROL_PLANE_API_KEY..."
$keyStatusItem = New-Object System.Windows.Forms.MenuItem "Show key status"
$copyMcpItem = New-Object System.Windows.Forms.MenuItem "Copy MCP URL"
$copyTunnelIdItem = New-Object System.Windows.Forms.MenuItem "Copy tunnel ID"
$copyHealthItem = New-Object System.Windows.Forms.MenuItem "Copy health URL"
$openHealthItem = New-Object System.Windows.Forms.MenuItem "Open MCP health"
$openTunnelUiItem = New-Object System.Windows.Forms.MenuItem "Open tunnel UI"
$openRuntimeItem = New-Object System.Windows.Forms.MenuItem "Open runtime logs"
$exitItem = New-Object System.Windows.Forms.MenuItem $(if ($DiagnosticOnly) { "Exit diagnostic tray only" } else { "Exit" })

$restartItem.add_Click({
  if ($DiagnosticOnly) { Invoke-ControllerReload | Out-Null }
  else { Restart-OmiSearchServer | Out-Null }
  Update-TrayStatus
})
$saveKeyItem.add_Click({ Save-ControlPlaneApiKeyFromPrompt | Out-Null; Update-TrayStatus })
$keyStatusItem.add_Click({ Show-ControlPlaneApiKeyStatus })
$copyMcpItem.add_Click({ Copy-TextToClipboard $McpUrl })
$copyTunnelIdItem.add_Click({ Copy-TextToClipboard $TunnelId })
$copyHealthItem.add_Click({ Copy-TextToClipboard $HealthUrl })
$openHealthItem.add_Click({ Start-Process $HealthUrl })
$openTunnelUiItem.add_Click({ Start-Process $TunnelUiUrl })
$openRuntimeItem.add_Click({ Open-RuntimeLogs })
$exitItem.add_Click({
  if ($DiagnosticOnly) {
    $timer.Stop()
    $recordedTrayPid = 0
    if ((Test-Path -LiteralPath $TrayPidFile -PathType Leaf) -and [int]::TryParse(([IO.File]::ReadAllText($TrayPidFile).Trim()), [ref]$recordedTrayPid) -and $recordedTrayPid -eq $PID) {
      Remove-PidFile $TrayPidFile
    }
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    [System.Windows.Forms.Application]::Exit()
    return
  }
  $choice = [System.Windows.Forms.MessageBox]::Show(
    "Exit will stop the MCP server, tunnel, and tray. Continue?",
    $TrayDisplayName,
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Warning
  )
  if ($choice -ne [System.Windows.Forms.DialogResult]::Yes) { return }
  $timer.Stop()
  Stop-TunnelClient
  Stop-OmiSearchServer
  Remove-PidFile $TrayPidFile
  $notifyIcon.Visible = $false
  $notifyIcon.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$contextMenu.MenuItems.Add($statusItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
$contextMenu.MenuItems.Add($restartItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
$contextMenu.MenuItems.Add($copyMcpItem) | Out-Null
$contextMenu.MenuItems.Add($copyHealthItem) | Out-Null
$contextMenu.MenuItems.Add($copyTunnelIdItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
$contextMenu.MenuItems.Add($openHealthItem) | Out-Null
$contextMenu.MenuItems.Add($openTunnelUiItem) | Out-Null
$contextMenu.MenuItems.Add($openRuntimeItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
$contextMenu.MenuItems.Add($saveKeyItem) | Out-Null
$contextMenu.MenuItems.Add($keyStatusItem) | Out-Null
$contextMenu.MenuItems.Add("-") | Out-Null
$contextMenu.MenuItems.Add($exitItem) | Out-Null

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.ContextMenu = $contextMenu
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Warning
$notifyIcon.Text = "$TrayDisplayName | Starting"
$notifyIcon.Visible = $true

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2500
$timer.add_Tick({ Update-TrayStatus })
$timer.Start()

if ($ReplaceExisting) {
  Write-TrayLog "ReplaceExisting requested currentPid=$PID"
  Stop-RecordedProcess $TrayPidFile "previous OMI_search tray" @("powershell", "pwsh") $PSCommandPath | Out-Null
  if (-not $DiagnosticOnly) {
    Stop-TunnelClient
    Stop-OmiSearchServer
  }
}

Write-PidFile $TrayPidFile $PID
Write-TrayLog "Tray pid recorded pid=$PID"

if (-not $DiagnosticOnly -and -not $NoAutoStart) {
  Start-OmiSearchServer
  Start-TunnelClient
}

Update-TrayStatus
Write-TrayLog "Entering tray application loop"
[System.Windows.Forms.Application]::Run()
