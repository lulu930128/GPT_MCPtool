param(
    [ValidateSet("SelfTest", "Setup", "SetupReviewCredential", "SaveRuntimeKey", "KeyStatus", "Doctor", "Start", "Restart", "Status", "Stop")]
    [string]$Action = "Status",
    [string]$TunnelId,
    [string]$TunnelClientPath = "C:\GPT_MCPtool\project_reading\vendor\tunnel-client\tunnel-client.exe"
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
$runtimeKeySecretPath = Join-Path $secretDir "tunnel-runtime-api-key.dpapi"
$backendPidPath = Join-Path $runtimeDir "backend.pid"
$mcpPidPath = Join-Path $runtimeDir "mcp.pid"
$tunnelPidPath = Join-Path $runtimeDir "tunnel-client.pid"
$backendHealthUrl = "http://127.0.0.1:8765/health"
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

function Wait-HttpEndpoint([string]$Url, [int]$TimeoutSeconds, [string]$Name) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if (Test-HttpEndpoint $Url) {
            return
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    throw "$Name did not become ready within $TimeoutSeconds seconds."
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
        ExecutablePath = $executablePath
        CommandLine = if ($null -eq $cimProcess) { $null } else { $cimProcess.CommandLine }
        StartTime = $nativeProcess.StartTime
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
        return
    }
    $existing = @(Get-LoopbackListenerOwnerIds 8765)
    if ($existing.Count -gt 0) {
        throw "Port 8765 is occupied by a process that is not a healthy Memory Core backend."
    }
    Start-ProjectPythonProcess `
        -Arguments "-m uvicorn memory_core.main:app --host 127.0.0.1 --port 8765" `
        -PidPath $backendPidPath `
        -StdoutPath (Join-Path $runtimeDir "backend.stdout.log") `
        -StderrPath (Join-Path $runtimeDir "backend.stderr.log") `
        -EnvironmentValues @{ PYTHONUNBUFFERED = "1" } | Out-Null
    Wait-HttpEndpoint -Url $backendHealthUrl -TimeoutSeconds 15 -Name "Memory Core backend"
}

function Start-Mcp {
    if (Test-HttpEndpoint $mcpHealthUrl) {
        return
    }
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
                MEMORY_CORE_MCP_API_BASE_URL = "http://127.0.0.1:8765"
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
    Wait-HttpEndpoint -Url $mcpHealthUrl -TimeoutSeconds 15 -Name "Memory Core MCP"
}

function Start-Tunnel {
    if (Test-HttpEndpoint $tunnelReadyUrl) {
        return
    }
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
    Wait-HttpEndpoint -Url $tunnelReadyUrl -TimeoutSeconds 30 -Name "Memory Core secure tunnel"
}

function Get-StatusDocument {
    $backendProcess = Get-ManagedProcess $backendPidPath
    $mcpProcess = Get-ManagedProcess $mcpPidPath
    $tunnelProcess = Get-ManagedProcess $tunnelPidPath
    $backendListenerPids = @(Get-LoopbackListenerOwnerIds 8765)
    $mcpListenerPids = @(Get-LoopbackListenerOwnerIds 8818)
    $tunnelListenerPids = @(Get-LoopbackListenerOwnerIds 8800)
    return [ordered]@{
        backend = [ordered]@{
            healthy = Test-HttpEndpoint $backendHealthUrl
            pid = if ($null -eq $backendProcess) { $null } else { $backendProcess.ProcessId }
            listenerPids = $backendListenerPids
            url = $backendHealthUrl
        }
        mcp = [ordered]@{
            healthy = Test-HttpEndpoint $mcpHealthUrl
            pid = if ($null -eq $mcpProcess) { $null } else { $mcpProcess.ProcessId }
            listenerPids = $mcpListenerPids
            url = $mcpUrl
        }
        tunnel = [ordered]@{
            ready = Test-HttpEndpoint $tunnelReadyUrl
            pid = if ($null -eq $tunnelProcess) { $null } else { $tunnelProcess.ProcessId }
            listenerPids = $tunnelListenerPids
            adminUrl = $tunnelAdminUrl
            profileConfigured = Test-Path -LiteralPath $profilePath
        }
        secrets = [ordered]@{
            mcpClientTokenConfigured = Test-CurrentUserSecret $mcpClientSecretPath
            mcpReviewTokenConfigured = Test-CurrentUserSecret $mcpReviewSecretPath
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
    $process = Get-ManagedProcess $PidPath
    if ($null -eq $process) {
        Remove-Item -LiteralPath $PidPath -ErrorAction SilentlyContinue
        return
    }
    $resolvedActual = if ([string]::IsNullOrWhiteSpace($process.ExecutablePath)) { "" } else { [IO.Path]::GetFullPath($process.ExecutablePath) }
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
    if (-not $executableMatches) {
        throw "Refusing to stop PID $($process.ProcessId): executable ownership check failed."
    }
    $commandMatches = -not [string]::IsNullOrWhiteSpace($process.CommandLine) -and $process.CommandLine.Contains($ExpectedCommandFragment)
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
    if (-not $commandMatches -and -not $listenerMatches) {
        throw "Refusing to stop PID $($process.ProcessId): command/listener ownership checks failed."
    }
    & "$env:SystemRoot\System32\taskkill.exe" /PID $process.ProcessId /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Could not stop the verified process tree for PID $($process.ProcessId)."
    }
    Remove-Item -LiteralPath $PidPath -ErrorAction SilentlyContinue
}

function Stop-Stack {
    Stop-ManagedProcess -PidPath $tunnelPidPath -ExpectedExecutables @($TunnelClientPath) -ExpectedCommandFragment $profileName -ExpectedListenPort 8800
    Stop-ManagedProcess -PidPath $mcpPidPath -ExpectedExecutables @($pythonPath, $pythonBasePath) -ExpectedCommandFragment "memory_core.mcp.main" -ExpectedListenPort 8818
    Stop-ManagedProcess -PidPath $backendPidPath -ExpectedExecutables @($pythonPath, $pythonBasePath) -ExpectedCommandFragment "memory_core.main:app" -ExpectedListenPort 8765
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
        Get-StatusDocument | ConvertTo-Json -Depth 5
    }
    "SetupReviewCredential" {
        Ensure-McpReviewSecret
        Get-StatusDocument | ConvertTo-Json -Depth 5
    }
    "SaveRuntimeKey" {
        Save-RuntimeApiKey
    }
    "KeyStatus" {
        [ordered]@{
            mcpClientTokenConfigured = Test-CurrentUserSecret $mcpClientSecretPath
            mcpReviewTokenConfigured = Test-CurrentUserSecret $mcpReviewSecretPath
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
        Start-Backend
        Start-Mcp
        Invoke-TunnelDoctor
        Start-Tunnel
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
        Start-Backend
        Start-Mcp
        Invoke-TunnelDoctor
        Start-Tunnel
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
