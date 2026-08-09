param(
    [ValidateSet("SelfTest", "Setup", "SetupReviewCredential", "SetupViewerCredential", "SetupControlCenterCredential", "SaveRuntimeKey", "KeyStatus", "Doctor", "Start", "Restart", "Status", "Stop", "StartCore", "RestartCore", "StopCore", "StartTunnel", "StopTunnel")]
    [string]$Action = "Status",
    [string]$TunnelId,
    [string]$TunnelClientPath = "C:\GPT_MCPtool\project_reading\vendor\tunnel-client\tunnel-client.exe",
    [ValidateRange(1, 65535)]
    [int]$BackendPort = 18765
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$pythonPath = Join-Path $projectRoot ".venv\Scripts\python.exe"
$pythonBasePath = $null
$adminScript = Join-Path $projectRoot "scripts\memory_core_admin.py"
$dataDir = Join-Path $projectRoot "data"
$runtimeDir = Join-Path $dataDir "runtime"
$secretDir = Join-Path $dataDir "secrets"
$profileDir = Join-Path $dataDir "tunnel-client"
$profileName = "memory-core"
$profilePath = Join-Path $profileDir "$profileName.yaml"
$mcpClientSecretPath = Join-Path $secretDir "memory-mcp-client-token.dpapi"
$mcpReviewSecretPath = Join-Path $secretDir "memory-mcp-review-token.dpapi"
$viewerSecretPath = Join-Path $secretDir "memory-core-viewer-token.dpapi"
$controlCenterSecretPath = Join-Path $secretDir "memory-core-control-center-token.dpapi"
$runtimeKeySecretPath = Join-Path $secretDir "tunnel-runtime-api-key.dpapi"
$backendPidPath = Join-Path $runtimeDir "backend.pid"
$mcpPidPath = Join-Path $runtimeDir "mcp.pid"
$tunnelPidPath = Join-Path $runtimeDir "tunnel-client.pid"
$backendBaseUrl = "http://127.0.0.1:$BackendPort"
$backendHealthUrl = "$backendBaseUrl/health"
$mcpHealthUrl = "http://127.0.0.1:8818/health"
$mcpUrl = "http://127.0.0.1:8818/mcp"
$tunnelAdminUrl = "http://127.0.0.1:8800"
$tunnelReadyUrl = "$tunnelAdminUrl/readyz"

function Ensure-PrivateDirectories {
    New-Item -ItemType Directory -Force -Path $runtimeDir, $secretDir, $profileDir | Out-Null
}

function ConvertTo-PlainText([Security.SecureString]$SecureValue) {
    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        if ($pointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
    }
}

function Save-CurrentUserSecret([Security.SecureString]$Secret, [string]$Path) {
    Ensure-PrivateDirectories
    $encrypted = ConvertFrom-SecureString -SecureString $Secret
    $encoding = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($Path, $encrypted, $encoding)
}

function Read-CurrentUserSecret([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Required local DPAPI secret is missing."
    }
    $encrypted = [IO.File]::ReadAllText($Path).Trim()
    if ([string]::IsNullOrWhiteSpace($encrypted)) {
        throw "Required local DPAPI secret is empty."
    }
    $secure = ConvertTo-SecureString $encrypted
    try {
        return ConvertTo-PlainText $secure
    }
    finally {
        $secure.Dispose()
    }
}

function Test-CurrentUserSecret([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }
    $plain = $null
    try {
        $plain = Read-CurrentUserSecret $Path
        return -not [string]::IsNullOrWhiteSpace($plain)
    }
    catch {
        return $false
    }
    finally {
        $plain = $null
    }
}

function Assert-LocalRuntimeFiles {
    if (-not (Test-Path -LiteralPath $pythonPath)) {
        throw "Missing project Python runtime. Run 'uv sync --all-groups' first."
    }
    if (-not (Test-Path -LiteralPath $TunnelClientPath)) {
        throw "Missing tunnel-client.exe at the configured path."
    }
}

function Test-HttpEndpoint([string]$Url) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
        return $response.StatusCode -eq 200
    }
    catch {
        return $false
    }
}

function Wait-StableEndpoints(
    [string[]]$Urls,
    [int]$TimeoutSeconds,
    [string]$Name,
    [int]$RequiredConsecutiveSuccesses = 3,
    [int]$ProbeIntervalMilliseconds = 500
) {
    if ($Urls.Count -eq 0) {
        throw "$Name readiness check requires at least one endpoint."
    }
    if ($RequiredConsecutiveSuccesses -lt 1) {
        throw "$Name readiness check requires at least one successful probe."
    }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $consecutiveSuccesses = 0
    do {
        $allReady = $true
        foreach ($url in $Urls) {
            if (-not (Test-HttpEndpoint $url)) {
                $allReady = $false
                break
            }
        }
        if ($allReady) {
            $consecutiveSuccesses += 1
            if ($consecutiveSuccesses -ge $RequiredConsecutiveSuccesses) {
                return
            }
        }
        else {
            $consecutiveSuccesses = 0
        }
        if ((Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds $ProbeIntervalMilliseconds
        }
    } while ((Get-Date) -lt $deadline)
    throw "$Name did not remain ready for $RequiredConsecutiveSuccesses consecutive probes within $TimeoutSeconds seconds."
}

function Get-LoopbackListenerOwnerIds([int]$Port) {
    $pattern = "^\s*TCP\s+127\.0\.0\.1:$Port\s+0\.0\.0\.0:0\s+\S+\s+(\d+)\s*$"
    $owners = @()
    foreach ($line in (& "$env:SystemRoot\System32\netstat.exe" -ano -p TCP)) {
        if ($line -match $pattern) {
            $owners += [int]$Matches[1]
        }
    }
    return @($owners | Select-Object -Unique)
}

function Get-ExcludedTcpPortSnapshot {
    $netshPath = Join-Path $env:SystemRoot "System32\netsh.exe"
    if (-not (Test-Path -LiteralPath $netshPath)) {
        return [pscustomobject]@{ available = $false; ranges = @() }
    }
    try {
        $lines = @(& $netshPath interface ipv4 show excludedportrange protocol=tcp 2>$null)
        if ($LASTEXITCODE -ne 0) {
            return [pscustomobject]@{ available = $false; ranges = @() }
        }
    }
    catch {
        return [pscustomobject]@{ available = $false; ranges = @() }
    }

    $ranges = @()
    foreach ($line in $lines) {
        if ($line -match '^\s*(\d+)\s+(\d+)(?:\s+\*)?\s*$') {
            $startPort = [int]$Matches[1]
            $endPort = [int]$Matches[2]
            if ($startPort -ge 1 -and $endPort -ge $startPort -and $endPort -le 65535) {
                $ranges += [pscustomobject]@{ start = $startPort; end = $endPort }
            }
        }
    }
    return [pscustomobject]@{ available = $true; ranges = $ranges }
}

function Get-BackendPortPreflight([int]$Port) {
    $existing = @(Get-LoopbackListenerOwnerIds $Port)
    if ($existing.Count -gt 0) {
        return [pscustomobject][ordered]@{
            port = $Port
            status = "Occupied"
            errorCode = "MEMORY_CORE_BACKEND_PORT_OCCUPIED"
            excludedRangeCheckAvailable = $null
            socketError = $null
        }
    }

    $excludedSnapshot = Get-ExcludedTcpPortSnapshot
    $excluded = @($excludedSnapshot.ranges | Where-Object { $Port -ge $_.start -and $Port -le $_.end }).Count -gt 0
    if ($excluded) {
        return [pscustomobject][ordered]@{
            port = $Port
            status = "Excluded"
            errorCode = "MEMORY_CORE_BACKEND_PORT_EXCLUDED"
            excludedRangeCheckAvailable = [bool]$excludedSnapshot.available
            socketError = $null
        }
    }

    $listener = $null
    try {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
        $listener.Start()
        return [pscustomobject][ordered]@{
            port = $Port
            status = "Available"
            errorCode = $null
            excludedRangeCheckAvailable = [bool]$excludedSnapshot.available
            socketError = $null
        }
    }
    catch [Net.Sockets.SocketException] {
        return [pscustomobject][ordered]@{
            port = $Port
            status = "Unavailable"
            errorCode = "MEMORY_CORE_BACKEND_PORT_UNAVAILABLE"
            excludedRangeCheckAvailable = [bool]$excludedSnapshot.available
            socketError = [string]$_.Exception.SocketErrorCode
        }
    }
    finally {
        if ($null -ne $listener) {
            $listener.Stop()
        }
    }
}

function Assert-BackendPortAvailable {
    $preflight = Get-BackendPortPreflight -Port $BackendPort
    if ($preflight.status -eq "Available") {
        return
    }
    $message = switch ($preflight.status) {
        "Excluded" { "$($preflight.errorCode): loopback port $BackendPort is reserved by Windows." }
        "Occupied" { "$($preflight.errorCode): loopback port $BackendPort already has a listener." }
        default { "$($preflight.errorCode): loopback port $BackendPort cannot be bound (socketError=$($preflight.socketError))." }
    }
    $exception = [InvalidOperationException]::new($message)
    $exception.Data["MemoryCoreRetryable"] = $false
    throw $exception
}

function Read-ManagedPid([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }
    $value = 0
    if (-not [int]::TryParse(([IO.File]::ReadAllText($Path).Trim()), [ref]$value)) {
        return $null
    }
    return $value
}

function Get-ManagedProcess([string]$PidPath) {
    $processId = Read-ManagedPid $PidPath
    if ($null -eq $processId) {
        return $null
    }
    $cimProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
    $nativeProcess = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($null -eq $nativeProcess) {
        return $null
    }
    $executablePath = if ($null -ne $cimProcess -and -not [string]::IsNullOrWhiteSpace($cimProcess.ExecutablePath)) {
        $cimProcess.ExecutablePath
    }
    else {
        $nativeProcess.Path
    }
    return [pscustomobject]@{
        ProcessId = $nativeProcess.Id
        ProcessName = $nativeProcess.ProcessName
        ExecutablePath = $executablePath
        CommandLine = if ($null -eq $cimProcess) { $null } else { $cimProcess.CommandLine }
        StartTime = $nativeProcess.StartTime
    }
}

function Get-ManagedProcessOwnership(
    [string]$PidPath,
    [string[]]$ExpectedExecutables,
    [string]$ExpectedCommandFragment,
    [int]$ExpectedListenPort
) {
    $pidFileExists = Test-Path -LiteralPath $PidPath
    $recordedProcessId = Read-ManagedPid $PidPath
    $process = Get-ManagedProcess $PidPath
    if ($null -eq $process) {
        $state = if ($pidFileExists) { "stale_missing_process" } else { "missing" }
        return [pscustomobject]@{
            State = $state
            Owned = $false
            Stale = $pidFileExists
            RecordedProcessId = $recordedProcessId
            Process = $null
        }
    }

    $expectedProcessNames = @(
        foreach ($expectedExecutable in $ExpectedExecutables) {
            if (-not [string]::IsNullOrWhiteSpace($expectedExecutable)) {
                [IO.Path]::GetFileNameWithoutExtension($expectedExecutable)
            }
        }
    )
    $processNameMatches = $expectedProcessNames -contains $process.ProcessName

    $resolvedActual = if ([string]::IsNullOrWhiteSpace($process.ExecutablePath)) {
        ""
    }
    else {
        [IO.Path]::GetFullPath($process.ExecutablePath)
    }
    $executableMatches = $false
    foreach ($expectedExecutable in $ExpectedExecutables) {
        if ([string]::IsNullOrWhiteSpace($expectedExecutable)) {
            continue
        }
        $resolvedExpected = [IO.Path]::GetFullPath($expectedExecutable)
        if ($resolvedActual.Equals($resolvedExpected, [StringComparison]::OrdinalIgnoreCase)) {
            $executableMatches = $true
            break
        }
    }

    $commandMatches = (
        -not [string]::IsNullOrWhiteSpace($process.CommandLine) -and
        $process.CommandLine.Contains($ExpectedCommandFragment)
    )
    $listenerMatches = $false
    if (-not $commandMatches) {
        $listenerOwnerIds = @(Get-LoopbackListenerOwnerIds $ExpectedListenPort)
        foreach ($listenerOwnerId in $listenerOwnerIds) {
            if ($listenerOwnerId -eq $process.ProcessId) {
                $listenerMatches = $true
                break
            }
            $listenerProcess = Get-Process -Id $listenerOwnerId -ErrorAction SilentlyContinue
            if ($null -eq $listenerProcess -or [string]::IsNullOrWhiteSpace($listenerProcess.Path)) {
                continue
            }
            $resolvedListenerExecutable = [IO.Path]::GetFullPath($listenerProcess.Path)
            $listenerExecutableMatches = $false
            foreach ($expectedExecutable in $ExpectedExecutables) {
                if ([string]::IsNullOrWhiteSpace($expectedExecutable)) {
                    continue
                }
                $resolvedExpected = [IO.Path]::GetFullPath($expectedExecutable)
                if ($resolvedListenerExecutable.Equals($resolvedExpected, [StringComparison]::OrdinalIgnoreCase)) {
                    $listenerExecutableMatches = $true
                    break
                }
            }
            if (-not $listenerExecutableMatches) {
                continue
            }
            $startDeltaSeconds = [Math]::Abs(($listenerProcess.StartTime - $process.StartTime).TotalSeconds)
            if ($startDeltaSeconds -le 2) {
                $listenerMatches = $true
                break
            }
        }
    }

    $owned = $executableMatches -and ($commandMatches -or $listenerMatches)
    if ($owned) {
        $state = "owned"
    }
    elseif (-not $processNameMatches) {
        $state = "stale_process_name"
    }
    elseif (-not [string]::IsNullOrWhiteSpace($resolvedActual) -and -not $executableMatches) {
        $state = "stale_executable"
    }
    else {
        $state = "ownership_unverified"
    }

    return [pscustomobject]@{
        State = $state
        Owned = $owned
        Stale = $state.StartsWith("stale_", [StringComparison]::Ordinal)
        RecordedProcessId = $recordedProcessId
        Process = $process
    }
}

function Write-Pid([string]$Path, [int]$ProcessId) {
    Ensure-PrivateDirectories
    [IO.File]::WriteAllText($Path, [string]$ProcessId, (New-Object Text.UTF8Encoding($false)))
}

function Start-ProjectPythonProcess(
    [string]$Arguments,
    [string]$PidPath,
    [string]$StdoutPath,
    [string]$StderrPath,
    [hashtable]$EnvironmentValues
) {
    $originalValues = @{}
    foreach ($name in $EnvironmentValues.Keys) {
        $existing = Get-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        $originalValues[$name] = if ($null -eq $existing) { $null } else { $existing.Value }
        Set-Item -LiteralPath "Env:$name" -Value ([string]$EnvironmentValues[$name])
    }
    try {
        $process = Start-Process -FilePath $pythonPath `
            -ArgumentList $Arguments `
            -WorkingDirectory $projectRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput $StdoutPath `
            -RedirectStandardError $StderrPath `
            -PassThru
        Write-Pid $PidPath $process.Id
        return $process.Id
    }
    finally {
        foreach ($name in $EnvironmentValues.Keys) {
            if ($null -eq $originalValues[$name]) {
                Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
            }
            else {
                Set-Item -LiteralPath "Env:$name" -Value $originalValues[$name]
            }
        }
    }
}

function Invoke-CapturedProcess([string]$FilePath, [string]$Arguments) {
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = $Arguments
    $startInfo.WorkingDirectory = $projectRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($startInfo)
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    return [pscustomobject]@{
        exitCode = $process.ExitCode
        stdout = $stdout
        stderr = $stderr
    }
}

function Ensure-McpClientSecret {
    if (Test-CurrentUserSecret $mcpClientSecretPath) {
        return
    }
    $arguments = '-B "' + $adminScript + '" create-client --name memory-mcp-tunnel --scope records:read --scope entities:read --scope candidates:create'
    $result = Invoke-CapturedProcess -FilePath $pythonPath -Arguments $arguments
    if ($result.exitCode -ne 0) {
        $safeError = ([string]$result.stderr) -replace 'mcore_[A-Za-z0-9_-]+', '<redacted>'
        throw "Could not create the low-scope Memory Core client. $safeError"
    }
    $match = [regex]::Match([string]$result.stdout, '(?m)^Token:\s*(mcore_[A-Za-z0-9_-]+)\s*$')
    if (-not $match.Success) {
        throw "The Memory Core admin command did not return the expected one-time token."
    }
    $plainToken = $match.Groups[1].Value
    $secureToken = ConvertTo-SecureString $plainToken -AsPlainText -Force
    try {
        Save-CurrentUserSecret -Secret $secureToken -Path $mcpClientSecretPath
    }
    finally {
        $plainToken = $null
        $secureToken.Dispose()
        $result = $null
    }
}

function Ensure-McpReviewSecret {
    if (Test-CurrentUserSecret $mcpReviewSecretPath) {
        return
    }
    $arguments = '-B "' + $adminScript + '" create-client --name memory-mcp-review --scope candidates:review'
    $result = Invoke-CapturedProcess -FilePath $pythonPath -Arguments $arguments
    if ($result.exitCode -ne 0) {
        $safeError = ([string]$result.stderr) -replace 'mcore_[A-Za-z0-9_-]+', '<redacted>'
        throw "Could not create the isolated Memory Core review client. $safeError"
    }
    $match = [regex]::Match([string]$result.stdout, '(?m)^Token:\s*(mcore_[A-Za-z0-9_-]+)\s*$')
    if (-not $match.Success) {
        throw "The Memory Core admin command did not return the expected one-time review token."
    }
    $plainToken = $match.Groups[1].Value
    $secureToken = ConvertTo-SecureString $plainToken -AsPlainText -Force
    try {
        Save-CurrentUserSecret -Secret $secureToken -Path $mcpReviewSecretPath
    }
    finally {
        $plainToken = $null
        $secureToken.Dispose()
        $result = $null
    }
}

function Ensure-ViewerSecret {
    if (Test-CurrentUserSecret $viewerSecretPath) {
        return
    }
    $arguments = '-B "' + $adminScript + '" create-client --name memory-core-viewer --scope records:read --scope entities:read'
    $result = Invoke-CapturedProcess -FilePath $pythonPath -Arguments $arguments
    if ($result.exitCode -ne 0) {
        $safeError = ([string]$result.stderr) -replace 'mcore_[A-Za-z0-9_-]+', '<redacted>'
        throw "Could not create the read-only Memory Core viewer client. $safeError"
    }
    $match = [regex]::Match([string]$result.stdout, '(?m)^Token:\s*(mcore_[A-Za-z0-9_-]+)\s*$')
    if (-not $match.Success) {
        throw "The Memory Core admin command did not return the expected one-time viewer token."
    }
    $plainToken = $match.Groups[1].Value
    $secureToken = ConvertTo-SecureString $plainToken -AsPlainText -Force
    try {
        Save-CurrentUserSecret -Secret $secureToken -Path $viewerSecretPath
    }
    finally {
        $plainToken = $null
        $secureToken.Dispose()
        $result = $null
    }
}

function Ensure-ControlCenterSecret {
    if (Test-CurrentUserSecret $controlCenterSecretPath) {
        return
    }
    $arguments = '-B "' + $adminScript + '" create-client --name memory-core-control-center' +
        ' --scope records:read --scope records:write' +
        ' --scope entities:read --scope entities:write' +
        ' --scope restricted:read --scope restricted:write' +
        ' --scope candidates:create --scope candidates:review' +
        ' --scope admin:export --scope admin:backup'
    $result = Invoke-CapturedProcess -FilePath $pythonPath -Arguments $arguments
    if ($result.exitCode -ne 0) {
        $safeError = ([string]$result.stderr) -replace 'mcore_[A-Za-z0-9_-]+', '<redacted>'
        throw "Could not create the Memory Core control-center client. $safeError"
    }
    $match = [regex]::Match([string]$result.stdout, '(?m)^Token:\s*(mcore_[A-Za-z0-9_-]+)\s*$')
    if (-not $match.Success) {
        throw "The Memory Core admin command did not return the expected control-center token."
    }
    $plainToken = $match.Groups[1].Value
    $secureToken = ConvertTo-SecureString $plainToken -AsPlainText -Force
    try {
        Save-CurrentUserSecret -Secret $secureToken -Path $controlCenterSecretPath
    }
    finally {
        $plainToken = $null
        $secureToken.Dispose()
        $result = $null
    }
}

function Save-RuntimeApiKey {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    $form = New-Object Windows.Forms.Form
    $form.Text = "Memory Core - Tunnel Runtime Key"
    $form.Width = 600
    $form.Height = 205
    $form.FormBorderStyle = [Windows.Forms.FormBorderStyle]::FixedDialog
    $form.StartPosition = [Windows.Forms.FormStartPosition]::CenterScreen
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.TopMost = $true

    $label = New-Object Windows.Forms.Label
    $label.Left = 14
    $label.Top = 14
    $label.Width = 555
    $label.Height = 45
    $label.Text = "Paste a newly rotated tunnel runtime API key. Do not reuse a key that has appeared in chat or logs. It will be encrypted with Windows DPAPI."

    $textBox = New-Object Windows.Forms.TextBox
    $textBox.Left = 14
    $textBox.Top = 66
    $textBox.Width = 555
    $textBox.UseSystemPasswordChar = $true

    $saveButton = New-Object Windows.Forms.Button
    $saveButton.Text = "Save"
    $saveButton.Left = 390
    $saveButton.Top = 108
    $saveButton.Width = 84
    $saveButton.DialogResult = [Windows.Forms.DialogResult]::OK

    $cancelButton = New-Object Windows.Forms.Button
    $cancelButton.Text = "Cancel"
    $cancelButton.Left = 485
    $cancelButton.Top = 108
    $cancelButton.Width = 84
    $cancelButton.DialogResult = [Windows.Forms.DialogResult]::Cancel

    $form.Controls.Add($label) | Out-Null
    $form.Controls.Add($textBox) | Out-Null
    $form.Controls.Add($saveButton) | Out-Null
    $form.Controls.Add($cancelButton) | Out-Null
    $form.AcceptButton = $saveButton
    $form.CancelButton = $cancelButton

    $result = $form.ShowDialog()
    if ($result -ne [Windows.Forms.DialogResult]::OK) {
        $textBox.Text = ""
        $form.Dispose()
        Write-Host "Tunnel runtime API key setup was cancelled."
        return
    }

    $plainKey = $textBox.Text.Trim()
    $textBox.Text = ""
    $form.Dispose()
    $secureKey = ConvertTo-SecureString $plainKey -AsPlainText -Force
    try {
        if ([string]::IsNullOrWhiteSpace($plainKey)) {
            throw "Tunnel runtime API key is empty."
        }
        if (-not $plainKey.StartsWith("sk-", [StringComparison]::Ordinal)) {
            throw "Tunnel runtime API key must start with 'sk-'."
        }
        Save-CurrentUserSecret -Secret $secureKey -Path $runtimeKeySecretPath
        [Windows.Forms.MessageBox]::Show(
            "The runtime API key was saved with Windows DPAPI for the current user.",
            "Memory Core",
            [Windows.Forms.MessageBoxButtons]::OK,
            [Windows.Forms.MessageBoxIcon]::Information
        ) | Out-Null
    }
    catch {
        [Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            "Memory Core",
            [Windows.Forms.MessageBoxButtons]::OK,
            [Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
        throw
    }
    finally {
        $plainKey = $null
        $secureKey.Dispose()
    }
}

function Initialize-TunnelProfile {
    if ([string]::IsNullOrWhiteSpace($TunnelId) -or -not $TunnelId.StartsWith("tunnel_", [StringComparison]::Ordinal)) {
        throw "Setup requires a valid -TunnelId tunnel_... value."
    }
    Ensure-PrivateDirectories
    & $TunnelClientPath init `
        --profile-dir $profileDir `
        --profile $profileName `
        --sample sample_mcp_remote_no_auth `
        --tunnel-id $TunnelId `
        --mcp-server-url $mcpUrl `
        --control-plane-api-key-ref env:CONTROL_PLANE_API_KEY `
        --health-listen-addr "127.0.0.1:8800" `
        --force
    if ($LASTEXITCODE -ne 0) {
        throw "tunnel-client profile initialization failed with exit code $LASTEXITCODE."
    }
}

function Invoke-TunnelDoctor {
    if (-not (Test-Path -LiteralPath $profilePath)) {
        throw "Tunnel profile is missing. Run Setup first."
    }
    $runtimeKey = Read-CurrentUserSecret $runtimeKeySecretPath
    $originalKey = $env:CONTROL_PLANE_API_KEY
    try {
        $env:CONTROL_PLANE_API_KEY = $runtimeKey
        $arguments = "doctor --profile-dir `"$profileDir`" --profile $profileName --json"
        $result = Invoke-CapturedProcess -FilePath $TunnelClientPath -Arguments $arguments
        try {
            $document = $result.stdout | ConvertFrom-Json
        }
        catch {
            throw "tunnel-client doctor did not return valid JSON."
        }

        if ($result.exitCode -eq 0 -and $document.result -eq "pass") {
            Write-Host "Tunnel doctor passed."
            return
        }

        $failedChecks = @($document.failed_checks)
        $oauthCheck = @($document.checks | Where-Object { $_.id -eq "oauth_metadata" })
        $expectedNoAuthMetadata = (
            $failedChecks.Count -eq 1 -and
            $failedChecks[0] -eq "oauth_metadata" -and
            $oauthCheck.Count -eq 1 -and
            $oauthCheck[0].status -eq "FAIL" -and
            ([string]$oauthCheck[0].summary).Contains("HTTP 404")
        )
        if ($expectedNoAuthMetadata) {
            Write-Warning "Tunnel doctor found only the expected OAuth metadata 404 for the intentional no-auth MCP profile."
            return
        }

        $safeFailedChecks = if ($failedChecks.Count -eq 0) { "unknown" } else { $failedChecks -join ", " }
        throw "tunnel-client doctor failed checks: $safeFailedChecks."
    }
    finally {
        $env:CONTROL_PLANE_API_KEY = $originalKey
        $runtimeKey = $null
    }
}

function Start-Backend {
    if (Test-HttpEndpoint $backendHealthUrl) {
        Wait-StableEndpoints -Urls @($backendHealthUrl) -TimeoutSeconds 20 -Name "Memory Core backend"
        return
    }
    Stop-ManagedProcess `
        -PidPath $backendPidPath `
        -ExpectedExecutables @($pythonPath, $pythonBasePath) `
        -ExpectedCommandFragment "memory_core.main:app" `
        -ExpectedListenPort $BackendPort
    Assert-BackendPortAvailable
    Start-ProjectPythonProcess `
        -Arguments "-m uvicorn memory_core.main:app --host 127.0.0.1 --port $BackendPort" `
        -PidPath $backendPidPath `
        -StdoutPath (Join-Path $runtimeDir "backend.stdout.log") `
        -StderrPath (Join-Path $runtimeDir "backend.stderr.log") `
        -EnvironmentValues @{
            PYTHONUNBUFFERED = "1"
            MEMORY_CORE_PORT = [string]$BackendPort
        } | Out-Null
    Wait-StableEndpoints -Urls @($backendHealthUrl) -TimeoutSeconds 20 -Name "Memory Core backend"
}

function Start-Mcp {
    if (Test-HttpEndpoint $mcpHealthUrl) {
        Wait-StableEndpoints -Urls @($mcpHealthUrl) -TimeoutSeconds 20 -Name "Memory Core MCP"
        return
    }
    Stop-ManagedProcess `
        -PidPath $mcpPidPath `
        -ExpectedExecutables @($pythonPath, $pythonBasePath) `
        -ExpectedCommandFragment "memory_core.mcp.main" `
        -ExpectedListenPort 8818
    $existing = @(Get-LoopbackListenerOwnerIds 8818)
    if ($existing.Count -gt 0) {
        throw "Port 8818 is occupied by a process that is not a healthy Memory Core MCP server."
    }
    $mcpToken = Read-CurrentUserSecret $mcpClientSecretPath
    $mcpReviewToken = Read-CurrentUserSecret $mcpReviewSecretPath
    try {
        Start-ProjectPythonProcess `
            -Arguments "-m memory_core.mcp.main" `
            -PidPath $mcpPidPath `
            -StdoutPath (Join-Path $runtimeDir "mcp.stdout.log") `
            -StderrPath (Join-Path $runtimeDir "mcp.stderr.log") `
            -EnvironmentValues @{
                PYTHONUNBUFFERED = "1"
                MEMORY_CORE_MCP_API_BASE_URL = $backendBaseUrl
                MEMORY_CORE_MCP_HOST = "127.0.0.1"
                MEMORY_CORE_MCP_PORT = "8818"
                MEMORY_CORE_MCP_CLIENT_TOKEN = $mcpToken
                MEMORY_CORE_MCP_REVIEW_CLIENT_TOKEN = $mcpReviewToken
            } | Out-Null
    }
    finally {
        $mcpToken = $null
        $mcpReviewToken = $null
    }
    Wait-StableEndpoints -Urls @($mcpHealthUrl) -TimeoutSeconds 20 -Name "Memory Core MCP"
}

function Start-Tunnel {
    if (Test-HttpEndpoint $tunnelReadyUrl) {
        Wait-StableEndpoints -Urls @($tunnelReadyUrl) -TimeoutSeconds 30 -Name "Memory Core secure tunnel"
        return
    }
    Invoke-TunnelDoctor
    Stop-ManagedProcess `
        -PidPath $tunnelPidPath `
        -ExpectedExecutables @($TunnelClientPath) `
        -ExpectedCommandFragment $profileName `
        -ExpectedListenPort 8800
    $existing = @(Get-LoopbackListenerOwnerIds 8800)
    if ($existing.Count -gt 0) {
        throw "Port 8800 is occupied by a process that is not a ready Memory Core tunnel."
    }
    $runtimeKey = Read-CurrentUserSecret $runtimeKeySecretPath
    $originalKey = $env:CONTROL_PLANE_API_KEY
    try {
        $env:CONTROL_PLANE_API_KEY = $runtimeKey
        $arguments = "run --profile-dir `"$profileDir`" --profile $profileName --log.file `"$(Join-Path $runtimeDir 'tunnel-client.log')`" --pid.file `"$tunnelPidPath`""
        $process = Start-Process -FilePath $TunnelClientPath `
            -ArgumentList $arguments `
            -WorkingDirectory $projectRoot `
            -WindowStyle Hidden `
            -PassThru
        Write-Pid $tunnelPidPath $process.Id
    }
    finally {
        $env:CONTROL_PLANE_API_KEY = $originalKey
        $runtimeKey = $null
    }
    Wait-StableEndpoints -Urls @($tunnelReadyUrl) -TimeoutSeconds 30 -Name "Memory Core secure tunnel"
}

function Get-StatusDocument {
    $backendHealthy = Test-HttpEndpoint $backendHealthUrl
    $backendOwnership = Get-ManagedProcessOwnership `
        -PidPath $backendPidPath `
        -ExpectedExecutables @($pythonPath, $pythonBasePath) `
        -ExpectedCommandFragment "memory_core.main:app" `
        -ExpectedListenPort $BackendPort
    $mcpOwnership = Get-ManagedProcessOwnership `
        -PidPath $mcpPidPath `
        -ExpectedExecutables @($pythonPath, $pythonBasePath) `
        -ExpectedCommandFragment "memory_core.mcp.main" `
        -ExpectedListenPort 8818
    $tunnelOwnership = Get-ManagedProcessOwnership `
        -PidPath $tunnelPidPath `
        -ExpectedExecutables @($TunnelClientPath) `
        -ExpectedCommandFragment $profileName `
        -ExpectedListenPort 8800
    $backendListenerPids = @(Get-LoopbackListenerOwnerIds $BackendPort)
    $mcpListenerPids = @(Get-LoopbackListenerOwnerIds 8818)
    $tunnelListenerPids = @(Get-LoopbackListenerOwnerIds 8800)
    $backendPortPreflight = if ($backendHealthy) {
        [pscustomobject][ordered]@{
            port = $BackendPort
            status = "InUseHealthy"
            errorCode = $null
            excludedRangeCheckAvailable = $null
            socketError = $null
        }
    }
    else {
        Get-BackendPortPreflight -Port $BackendPort
    }
    return [ordered]@{
        backend = [ordered]@{
            healthy = $backendHealthy
            pid = if ($backendOwnership.Owned) { $backendOwnership.Process.ProcessId } else { $null }
            pidState = $backendOwnership.State
            recordedPid = $backendOwnership.RecordedProcessId
            listenerPids = $backendListenerPids
            url = $backendHealthUrl
            portPreflight = $backendPortPreflight
        }
        mcp = [ordered]@{
            healthy = Test-HttpEndpoint $mcpHealthUrl
            pid = if ($mcpOwnership.Owned) { $mcpOwnership.Process.ProcessId } else { $null }
            pidState = $mcpOwnership.State
            recordedPid = $mcpOwnership.RecordedProcessId
            listenerPids = $mcpListenerPids
            url = $mcpUrl
        }
        tunnel = [ordered]@{
            ready = Test-HttpEndpoint $tunnelReadyUrl
            pid = if ($tunnelOwnership.Owned) { $tunnelOwnership.Process.ProcessId } else { $null }
            pidState = $tunnelOwnership.State
            recordedPid = $tunnelOwnership.RecordedProcessId
            listenerPids = $tunnelListenerPids
            adminUrl = $tunnelAdminUrl
            profileConfigured = Test-Path -LiteralPath $profilePath
        }
        secrets = [ordered]@{
            mcpClientTokenConfigured = Test-CurrentUserSecret $mcpClientSecretPath
            mcpReviewTokenConfigured = Test-CurrentUserSecret $mcpReviewSecretPath
            viewerTokenConfigured = Test-CurrentUserSecret $viewerSecretPath
            controlCenterTokenConfigured = Test-CurrentUserSecret $controlCenterSecretPath
            tunnelRuntimeKeyConfigured = Test-CurrentUserSecret $runtimeKeySecretPath
            storage = "Windows DPAPI current-user"
        }
    }
}

function Stop-ManagedProcess(
    [string]$PidPath,
    [string[]]$ExpectedExecutables,
    [string]$ExpectedCommandFragment,
    [int]$ExpectedListenPort
) {
    $ownership = Get-ManagedProcessOwnership `
        -PidPath $PidPath `
        -ExpectedExecutables $ExpectedExecutables `
        -ExpectedCommandFragment $ExpectedCommandFragment `
        -ExpectedListenPort $ExpectedListenPort
    if ($null -eq $ownership.Process) {
        Remove-Item -LiteralPath $PidPath -ErrorAction SilentlyContinue
        return
    }
    if ($ownership.Stale) {
        Write-Warning "Ignoring stale managed PID $($ownership.Process.ProcessId) ($($ownership.State)); the foreign process will not be stopped."
        Remove-Item -LiteralPath $PidPath -ErrorAction Stop
        return
    }
    if (-not $ownership.Owned) {
        throw "Refusing to stop PID $($ownership.Process.ProcessId): process ownership could not be verified."
    }
    & "$env:SystemRoot\System32\taskkill.exe" /PID $ownership.Process.ProcessId /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Could not stop the verified process tree for PID $($ownership.Process.ProcessId)."
    }
    Remove-Item -LiteralPath $PidPath -ErrorAction SilentlyContinue
}

function Stop-Stack {
    Stop-ManagedProcess -PidPath $tunnelPidPath -ExpectedExecutables @($TunnelClientPath) -ExpectedCommandFragment $profileName -ExpectedListenPort 8800
    Stop-ManagedProcess -PidPath $mcpPidPath -ExpectedExecutables @($pythonPath, $pythonBasePath) -ExpectedCommandFragment "memory_core.mcp.main" -ExpectedListenPort 8818
    Stop-ManagedProcess -PidPath $backendPidPath -ExpectedExecutables @($pythonPath, $pythonBasePath) -ExpectedCommandFragment "memory_core.main:app" -ExpectedListenPort $BackendPort
}

function Stop-Core {
    Stop-ManagedProcess -PidPath $mcpPidPath -ExpectedExecutables @($pythonPath, $pythonBasePath) -ExpectedCommandFragment "memory_core.mcp.main" -ExpectedListenPort 8818
    Stop-ManagedProcess -PidPath $backendPidPath -ExpectedExecutables @($pythonPath, $pythonBasePath) -ExpectedCommandFragment "memory_core.main:app" -ExpectedListenPort $BackendPort
}

function Stop-Tunnel {
    Stop-ManagedProcess -PidPath $tunnelPidPath -ExpectedExecutables @($TunnelClientPath) -ExpectedCommandFragment $profileName -ExpectedListenPort 8800
}

function Assert-CoreStable {
    Wait-StableEndpoints `
        -Urls @($backendHealthUrl, $mcpHealthUrl) `
        -TimeoutSeconds 15 `
        -Name "Memory Core backend and MCP"
}

function Assert-StackStable {
    Wait-StableEndpoints `
        -Urls @($backendHealthUrl, $mcpHealthUrl, $tunnelReadyUrl) `
        -TimeoutSeconds 20 `
        -Name "Memory Core stack"
}

function Invoke-BoundedStartup(
    [string]$Name,
    [scriptblock]$Operation,
    [scriptblock]$Cleanup,
    [int[]]$BackoffSeconds
) {
    if ($BackoffSeconds.Count -eq 0) {
        throw "$Name startup requires at least one attempt."
    }

    $attemptCount = $BackoffSeconds.Count
    for ($attemptIndex = 0; $attemptIndex -lt $attemptCount; $attemptIndex++) {
        $delaySeconds = $BackoffSeconds[$attemptIndex]
        if ($delaySeconds -gt 0) {
            Write-Warning "$Name retry $($attemptIndex + 1)/$attemptCount will start in $delaySeconds seconds."
            Start-Sleep -Seconds $delaySeconds
        }

        try {
            & $Operation
            return
        }
        catch {
            $failureMessage = $_.Exception.Message
            $retryable = -not (
                $_.Exception.Data.Contains("MemoryCoreRetryable") -and
                $_.Exception.Data["MemoryCoreRetryable"] -eq $false
            )
            Write-Warning "$Name start attempt $($attemptIndex + 1)/$attemptCount failed: $failureMessage"
            try {
                & $Cleanup
            }
            catch {
                $cleanupMessage = $_.Exception.Message
                throw "$Name cleanup failed after a startup error. Startup error: $failureMessage Cleanup error: $cleanupMessage"
            }

            if (-not $retryable) {
                throw "$Name stopped without retry. $failureMessage"
            }

            if ($attemptIndex -eq ($attemptCount - 1)) {
                throw "$Name failed after $attemptCount attempts. Last error: $failureMessage"
            }
        }
    }
}

function Start-CoreWithRetry {
    Invoke-BoundedStartup `
        -Name "Memory Core core services" `
        -BackoffSeconds @(0, 5, 15, 30) `
        -Operation {
            Start-Backend
            Start-Mcp
            Assert-CoreStable
        } `
        -Cleanup {
            Stop-Core
        }
}

function Start-StackWithRetry {
    Invoke-BoundedStartup `
        -Name "Memory Core stack" `
        -BackoffSeconds @(0, 5, 15, 30) `
        -Operation {
            Start-Backend
            Start-Mcp
            Start-Tunnel
            Assert-StackStable
        } `
        -Cleanup {
            Stop-Stack
        }
}

Assert-LocalRuntimeFiles
$pythonBasePath = (& $pythonPath -I -c "import sys; print(sys._base_executable)").Trim()
if ([string]::IsNullOrWhiteSpace($pythonBasePath) -or -not (Test-Path -LiteralPath $pythonBasePath)) {
    throw "Could not resolve the base Python executable used by the project virtual environment."
}

switch ($Action) {
    "SelfTest" {
        Get-StatusDocument | ConvertTo-Json -Depth 5
    }
    "Setup" {
        Initialize-TunnelProfile
        Ensure-McpClientSecret
        Ensure-McpReviewSecret
        Ensure-ViewerSecret
        Ensure-ControlCenterSecret
        Get-StatusDocument | ConvertTo-Json -Depth 5
    }
    "SetupReviewCredential" {
        Ensure-McpReviewSecret
        Get-StatusDocument | ConvertTo-Json -Depth 5
    }
    "SetupViewerCredential" {
        Ensure-ViewerSecret
        Get-StatusDocument | ConvertTo-Json -Depth 5
    }
    "SetupControlCenterCredential" {
        Ensure-ControlCenterSecret
        Get-StatusDocument | ConvertTo-Json -Depth 5
    }
    "SaveRuntimeKey" {
        Save-RuntimeApiKey
    }
    "KeyStatus" {
        [ordered]@{
            mcpClientTokenConfigured = Test-CurrentUserSecret $mcpClientSecretPath
            mcpReviewTokenConfigured = Test-CurrentUserSecret $mcpReviewSecretPath
            viewerTokenConfigured = Test-CurrentUserSecret $viewerSecretPath
            controlCenterTokenConfigured = Test-CurrentUserSecret $controlCenterSecretPath
            tunnelRuntimeKeyConfigured = Test-CurrentUserSecret $runtimeKeySecretPath
            storage = "Windows DPAPI current-user"
        } | ConvertTo-Json -Depth 3
    }
    "Doctor" {
        Invoke-TunnelDoctor
    }
    "Start" {
        if (-not (Test-Path -LiteralPath $profilePath)) {
            throw "Tunnel profile is missing. Run Setup first."
        }
        if (-not (Test-CurrentUserSecret $mcpClientSecretPath)) {
            throw "Memory Core MCP client credential is missing. Run Setup first."
        }
        if (-not (Test-CurrentUserSecret $mcpReviewSecretPath)) {
            throw "Memory Core MCP review credential is missing. Run SetupReviewCredential first."
        }
        if (-not (Test-CurrentUserSecret $runtimeKeySecretPath)) {
            throw "Tunnel runtime API key is missing. Run SaveRuntimeKey first."
        }
        Start-StackWithRetry
        Get-StatusDocument | ConvertTo-Json -Depth 5
    }
    "Restart" {
        if (-not (Test-Path -LiteralPath $profilePath)) {
            throw "Tunnel profile is missing. Run Setup first."
        }
        if (-not (Test-CurrentUserSecret $mcpClientSecretPath)) {
            throw "Memory Core MCP client credential is missing. Run Setup first."
        }
        if (-not (Test-CurrentUserSecret $mcpReviewSecretPath)) {
            throw "Memory Core MCP review credential is missing. Run SetupReviewCredential first."
        }
        if (-not (Test-CurrentUserSecret $runtimeKeySecretPath)) {
            throw "Tunnel runtime API key is missing. Run SaveRuntimeKey first."
        }
        Stop-Stack
        Start-StackWithRetry
        Get-StatusDocument | ConvertTo-Json -Depth 5
    }
    "StartCore" {
        if (-not (Test-CurrentUserSecret $mcpClientSecretPath)) {
            throw "Memory Core MCP client credential is missing. Run Setup first."
        }
        if (-not (Test-CurrentUserSecret $mcpReviewSecretPath)) {
            throw "Memory Core MCP review credential is missing. Run SetupReviewCredential first."
        }
        Start-CoreWithRetry
        Get-StatusDocument | ConvertTo-Json -Depth 5
    }
    "RestartCore" {
        if (-not (Test-CurrentUserSecret $mcpClientSecretPath)) {
            throw "Memory Core MCP client credential is missing. Run Setup first."
        }
        if (-not (Test-CurrentUserSecret $mcpReviewSecretPath)) {
            throw "Memory Core MCP review credential is missing. Run SetupReviewCredential first."
        }
        Stop-Core
        Start-CoreWithRetry
        Get-StatusDocument | ConvertTo-Json -Depth 5
    }
    "StopCore" {
        Stop-Core
        Get-StatusDocument | ConvertTo-Json -Depth 5
    }
    "StartTunnel" {
        if (-not (Test-Path -LiteralPath $profilePath)) {
            throw "Tunnel profile is missing. Run Setup first."
        }
        if (-not (Test-CurrentUserSecret $mcpClientSecretPath)) {
            throw "Memory Core MCP client credential is missing. Run Setup first."
        }
        if (-not (Test-CurrentUserSecret $mcpReviewSecretPath)) {
            throw "Memory Core MCP review credential is missing. Run SetupReviewCredential first."
        }
        if (-not (Test-CurrentUserSecret $runtimeKeySecretPath)) {
            throw "Tunnel runtime API key is missing. Run SaveRuntimeKey first."
        }
        Start-StackWithRetry
        Get-StatusDocument | ConvertTo-Json -Depth 5
    }
    "StopTunnel" {
        Stop-Tunnel
        Get-StatusDocument | ConvertTo-Json -Depth 5
    }
    "Status" {
        Get-StatusDocument | ConvertTo-Json -Depth 5
    }
    "Stop" {
        Stop-Stack
        Get-StatusDocument | ConvertTo-Json -Depth 5
    }
}
