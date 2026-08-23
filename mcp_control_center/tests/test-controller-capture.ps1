Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$script:Passed = 0
function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "Assertion failed: $Message" }
    $script:Passed++
}

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$module = Import-Module (Join-Path $projectRoot 'src\McpControlCenter.Core.psm1') -Force -PassThru
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("mcp-cc-capture-" + [Guid]::NewGuid().ToString('N'))
$controllerPath = Join-Path $testRoot 'runtime-control.ps1'
$childPidPath = Join-Path $testRoot 'inherited-child.pid'
$utf8 = New-Object Text.UTF8Encoding($false)

try {
    New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
    $controllerSource = @'
param([string]$Action)
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'skip-inherited-child.flag'))) {
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = Join-Path $PSHOME 'powershell.exe'
    $startInfo.Arguments = '-NoProfile -Command "Start-Sleep -Seconds 15"'
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $child = [Diagnostics.Process]::Start($startInfo)
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'inherited-child.pid'), [string]$child.Id, (New-Object Text.UTF8Encoding($false)))
}
[pscustomobject]@{ ok = $true; action = $Action } | ConvertTo-Json
'@
    [IO.File]::WriteAllText($controllerPath, $controllerSource, $utf8)

    $clock = [Diagnostics.Stopwatch]::StartNew()
    $execution = & $module {
        param($ScriptPath, $WorkingDirectory, $RuntimeRoot)
        $pid = $null
        Invoke-McpCcBoundedPowerShell `
            -ScriptPath $ScriptPath `
            -Arguments @('-Action', 'EnsureRunning') `
            -WorkingDirectory $WorkingDirectory `
            -RuntimeRoot $RuntimeRoot `
            -TimeoutSeconds 10
    } $controllerPath $testRoot $testRoot
    $clock.Stop()

    Assert-True ($execution.exitCode -eq 0) "controller exits successfully while its descendant remains alive (exitCode=$($execution.exitCode), stdout=$($execution.stdout))"
    $document = $execution.stdout | ConvertFrom-Json
    Assert-True ($document.ok -and $document.action -eq 'EnsureRunning') 'controller JSON is captured completely'
    Assert-True ($clock.ElapsedMilliseconds -lt 10000) 'inherited handles do not hold the manager action open'
    $heldCaptureFiles = @(Get-ChildItem -LiteralPath (Join-Path $testRoot 'action-capture') -File -ErrorAction SilentlyContinue)
    $childPid = [int]([IO.File]::ReadAllText($childPidPath).Trim())
    Assert-True ($null -ne (Get-Process -Id $childPid -ErrorAction SilentlyContinue)) 'controller descendant remains alive after the manager action returns'
    Assert-True ($heldCaptureFiles.Count -eq 0) 'the dedicated result pipe does not create capture files'
    Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue
    New-Item -ItemType File -Path (Join-Path $testRoot 'skip-inherited-child.flag') -Force | Out-Null
    $cleanupExecution = & $module {
        param($ScriptPath, $WorkingDirectory, $RuntimeRoot)
        $pid = $null
        Invoke-McpCcBoundedPowerShell `
            -ScriptPath $ScriptPath `
            -Arguments @('-Action', 'Status') `
            -WorkingDirectory $WorkingDirectory `
            -RuntimeRoot $RuntimeRoot `
            -TimeoutSeconds 10
    } $controllerPath $testRoot $testRoot
    Assert-True ($cleanupExecution.exitCode -eq 0) 'a later controller action succeeds after the inherited handle closes'
    Assert-True (@(Get-ChildItem -LiteralPath (Join-Path $testRoot 'action-capture') -File -ErrorAction SilentlyContinue).Count -eq 0) 'a later action also leaves the capture directory empty'

    [IO.File]::WriteAllText($controllerPath, 'param([string]$Action); Start-Sleep -Seconds 3', $utf8)
    $timedOut = $false
    try {
        $null = & $module {
            param($ScriptPath, $WorkingDirectory, $RuntimeRoot)
            Invoke-McpCcBoundedPowerShell -ScriptPath $ScriptPath -Arguments @('-Action', 'Status') -WorkingDirectory $WorkingDirectory -RuntimeRoot $RuntimeRoot -TimeoutSeconds 1
        } $controllerPath $testRoot $testRoot
    }
    catch { $timedOut = $true }
    Assert-True $timedOut 'controller execution retains its bounded timeout'

    [IO.File]::WriteAllText($controllerPath, 'param([string]$Action); Write-Output ("x" * 4096)', $utf8)
    $outputLimited = $false
    try {
        $null = & $module {
            param($ScriptPath, $WorkingDirectory, $RuntimeRoot)
            Invoke-McpCcBoundedPowerShell -ScriptPath $ScriptPath -Arguments @('-Action', 'Status') -WorkingDirectory $WorkingDirectory -RuntimeRoot $RuntimeRoot -TimeoutSeconds 10 -MaxCapturedOutputBytes 1024
        } $controllerPath $testRoot $testRoot
    }
    catch { $outputLimited = $true }
    Assert-True $outputLimited 'controller execution retains its bounded output limit'
    Assert-True (@(Get-ChildItem -LiteralPath (Join-Path $testRoot 'action-capture') -File -ErrorAction SilentlyContinue).Count -eq 0) 'failed controller actions do not create capture files'

    [pscustomobject]@{ ok = $true; assertions = $script:Passed } | ConvertTo-Json
}
finally {
    if (Test-Path -LiteralPath $childPidPath -PathType Leaf) {
        $childPidText = ([IO.File]::ReadAllText($childPidPath)).Trim()
        $childPid = 0
        if ([int]::TryParse($childPidText, [ref]$childPid)) {
            Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue
        }
    }
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
