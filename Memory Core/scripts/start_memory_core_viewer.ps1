param(
    [switch]$SelfTest,
    [ValidateRange(1, 65535)]
    [int]$BackendPort = 18765
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$pythonwPath = Join-Path $projectRoot ".venv\Scripts\pythonw.exe"
$stackScript = Join-Path $PSScriptRoot "memory_core_stack.ps1"
$controlCenterSecretPath = Join-Path $projectRoot "data\secrets\memory-core-control-center-token.dpapi"
$backendBaseUrl = "http://127.0.0.1:$BackendPort"
$backendHealthUrl = "$backendBaseUrl/health"
$powershellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

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

function Read-CurrentUserSecret([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Memory Core control-center credential is missing."
    }
    $encrypted = [IO.File]::ReadAllText($Path).Trim()
    if ([string]::IsNullOrWhiteSpace($encrypted)) {
        throw "Memory Core control-center credential is empty."
    }
    $secure = ConvertTo-SecureString $encrypted
    try {
        return ConvertTo-PlainText $secure
    }
    finally {
        $secure.Dispose()
    }
}

function Test-Backend {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $backendHealthUrl -TimeoutSec 2
        return $response.StatusCode -eq 200
    }
    catch {
        return $false
    }
}

function Show-Error([string]$Message) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        $Message,
        "Memory Core Control Center",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
}

if ($SelfTest) {
    [ordered]@{
        projectRoot = $projectRoot
        pythonwExists = Test-Path -LiteralPath $pythonwPath
        stackScriptExists = Test-Path -LiteralPath $stackScript
        controlCenterTokenConfigured = Test-Path -LiteralPath $controlCenterSecretPath
        backendHealthy = Test-Backend
        apiBaseUrl = $backendBaseUrl
    } | ConvertTo-Json -Depth 3
    exit 0
}

try {
    if (-not (Test-Path -LiteralPath $pythonwPath)) {
        throw "Missing project Python runtime. Run 'uv sync --all-groups' first."
    }
    if (-not (Test-Path -LiteralPath $controlCenterSecretPath)) {
        & $powershellPath -NoProfile -ExecutionPolicy Bypass -File $stackScript -Action SetupControlCenterCredential -BackendPort $BackendPort | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Could not create the control-center credential."
        }
    }
    if (-not (Test-Backend)) {
        throw "Memory Core backend is not ready. Start the stack from the tray, then try again."
    }

    $controlCenterToken = Read-CurrentUserSecret $controlCenterSecretPath
    $originalToken = [Environment]::GetEnvironmentVariable(
        "MEMORY_CORE_CONTROL_CENTER_TOKEN",
        "Process"
    )
    $originalBaseUrl = [Environment]::GetEnvironmentVariable(
        "MEMORY_CORE_CONTROL_CENTER_API_BASE_URL",
        "Process"
    )
    try {
        [Environment]::SetEnvironmentVariable(
            "MEMORY_CORE_CONTROL_CENTER_TOKEN",
            $controlCenterToken,
            "Process"
        )
        [Environment]::SetEnvironmentVariable(
            "MEMORY_CORE_CONTROL_CENTER_API_BASE_URL",
            $backendBaseUrl,
            "Process"
        )
        Start-Process `
            -FilePath $pythonwPath `
            -ArgumentList "-B -m memory_core.viewer.main" `
            -WorkingDirectory $projectRoot | Out-Null
    }
    finally {
        [Environment]::SetEnvironmentVariable(
            "MEMORY_CORE_CONTROL_CENTER_TOKEN",
            $originalToken,
            "Process"
        )
        [Environment]::SetEnvironmentVariable(
            "MEMORY_CORE_CONTROL_CENTER_API_BASE_URL",
            $originalBaseUrl,
            "Process"
        )
        $controlCenterToken = $null
    }
}
catch {
    Show-Error $_.Exception.Message
    exit 1
}
