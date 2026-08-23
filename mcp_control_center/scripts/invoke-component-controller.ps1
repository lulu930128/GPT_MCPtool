param(
    [Parameter(Mandatory = $true)][string]$ControllerPath,
    [Parameter(Mandatory = $true)][string]$ArgumentsBase64,
    [Parameter(Mandatory = $true)][string]$ResultPipeHandle,
    [Parameter(Mandatory = $true)][ValidateRange(1024, 1048576)][int]$MaxCapturedOutputBytes
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $ControllerPath -PathType Leaf)) {
    throw 'Component controller script is unavailable.'
}

if (-not ('McpControlCenter.NativeHandleMethods' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace McpControlCenter {
    public static class NativeHandleMethods {
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);
    }
}
'@
}

try {
    $argumentJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgumentsBase64))
    $argumentDocument = $argumentJson | ConvertFrom-Json
    $controllerArguments = @($argumentDocument.arguments | ForEach-Object { [string]$_ })
}
catch {
    throw 'Component controller arguments are malformed.'
}

$resultPipe = New-Object IO.Pipes.AnonymousPipeClientStream([IO.Pipes.PipeDirection]::Out, $ResultPipeHandle)
$resultPipeHandleValue = $resultPipe.SafePipeHandle.DangerousGetHandle()
# Only this short-lived wrapper may own the result channel. The controller's
# backend, MCP, and tunnel descendants must never inherit it.
if (-not [McpControlCenter.NativeHandleMethods]::SetHandleInformation($resultPipeHandleValue, [uint32]1, [uint32]0)) {
    $resultPipe.Dispose()
    throw 'Could not isolate the component controller result channel.'
}
$resultWriter = New-Object IO.StreamWriter($resultPipe, (New-Object Text.UTF8Encoding($false)), 4096, $true)

$controllerOutput = @()
$controllerErrors = @()
$controllerHadErrors = $false
$invocationTokens = @("& '$($ControllerPath.Replace("'", "''"))'")
foreach ($controllerArgument in $controllerArguments) {
    if ($controllerArgument -match '^-[A-Za-z][A-Za-z0-9_]*$') {
        $invocationTokens += $controllerArgument
    }
    else {
        $invocationTokens += "'$($controllerArgument.Replace("'", "''"))'"
    }
}
# A child runspace contains controller-level `exit` without terminating the
# wrapper before it can frame the JSON result.
$controllerPowerShell = [PowerShell]::Create()
try {
    [void]$controllerPowerShell.AddScript(($invocationTokens -join ' '))
    $controllerOutput = @($controllerPowerShell.Invoke())
    $controllerHadErrors = $controllerPowerShell.HadErrors
    $controllerErrors = @($controllerPowerShell.Streams.Error | ForEach-Object { [string]$_ })
}
finally {
    $controllerPowerShell.Dispose()
}

$controllerText = @($controllerOutput | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
$controllerErrorText = @($controllerErrors) -join [Environment]::NewLine
$capturedBytes = [Text.Encoding]::UTF8.GetByteCount($controllerText) + [Text.Encoding]::UTF8.GetByteCount($controllerErrorText)
$outputLimitExceeded = $capturedBytes -gt $MaxCapturedOutputBytes
$controllerExitCode = if ($controllerHadErrors) { 1 } else { 0 }

try {
    $controllerResult = $controllerText | ConvertFrom-Json -ErrorAction Stop
    if ($controllerResult.ok -is [bool] -and -not [bool]$controllerResult.ok) { $controllerExitCode = 1 }
}
catch { }

$frameDocument = [pscustomobject]@{
    protocol = 'mcpcc-controller-result-v1'
    exitCode = $controllerExitCode
    outputLimitExceeded = $outputLimitExceeded
    stdoutBase64 = $(if ($outputLimitExceeded) { '' } else { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($controllerText)) })
    stderrBase64 = $(if ($outputLimitExceeded) { '' } else { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($controllerErrorText)) })
}
$frameJson = $frameDocument | ConvertTo-Json -Compress
$frameBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($frameJson))
$resultWriter.WriteLine("MCPCC1:$frameBase64")
$resultWriter.Flush()
$resultWriter.Dispose()
$resultPipe.Dispose()
exit $controllerExitCode
