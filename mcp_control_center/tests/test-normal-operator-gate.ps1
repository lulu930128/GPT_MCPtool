$ErrorActionPreference='Stop'
Set-StrictMode -Version 3.0
$root=Split-Path -Parent $PSScriptRoot
$tokens=$null; $errors=$null
foreach ($relative in @('src\McpControlCenter.NormalOperator.psm1','scripts\normal-marker-operator.ps1',
    'scripts\normal-marker-preflight.ps1','scripts\tray.ps1')) {
    $null=[Management.Automation.Language.Parser]::ParseFile((Join-Path $root $relative),[ref]$tokens,[ref]$errors)
    if ($errors.Count) { throw ('PARSE_FAILED: '+$relative) }
}
$normal=Import-Module (Join-Path $root 'src\McpControlCenter.NormalOperator.psm1') -PassThru
# Exercise the actual private-helper route used by the gate, not a mock exported function.
& $normal {
    & $script:NormalInstallChecks { param($path) Assert-McpCcInstalledAbsolutePath $path } 'C:\fixture'
    & $script:NormalInstallChecks { param($value) Assert-McpCcInstalledFields $value @('contract','files') } ([pscustomobject]@{contract='fixture';files=@()})
    try {
        & $script:NormalInstallChecks { param($path) Assert-McpCcInstalledAbsolutePath $path } '..\fixture'
        throw 'NEGATIVE_PATH_ACCEPTED'
    } catch { if ($_.Exception.Message -cne 'INSTALLED_PATH_INVALID') { throw } }
}
# Evaluate only the source regex expressions; no InstalledActivation, startup/secret access,
# CIM enumeration, lifecycle action or host gate retry.
$installedAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'src\McpControlCenter.InstalledRelease.psm1'),[ref]$tokens,[ref]$errors)
$installedMatch=$installedAst.FindAll({param($node)
    $node -is [Management.Automation.Language.BinaryExpressionAst] -and
    $node.Left.Extent.Text -eq '$cim.CommandLine' -and $node.Operator -eq 'Inotmatch'
},$true)
if (@($installedMatch).Count -ne 1) { throw 'INSTALLED_REGEX_NOT_UNIQUE' }
$normalAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'src\McpControlCenter.NormalOperator.psm1'),[ref]$tokens,[ref]$errors)
$assignment=$normalAst.FindAll({param($node)
    $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$pattern'
},$true)
if (@($assignment).Count -ne 1) { throw 'NORMAL_REGEX_NOT_UNIQUE' }
$ps='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$expectedImage=$ps
$tray='C:\ProtectedFixture\mcp_control_center\scripts\tray.ps1'
$installedPattern=& ([scriptblock]::Create($installedMatch[0].Right.Extent.Text))
$normalPattern=& ([scriptblock]::Create($assignment[0].Right.Extent.Text))
foreach ($suffix in @('', ' -AutoReconcile')) {
    $command='"'+$ps+'" -NoProfile -File "'+$tray+'"'+$suffix
    if ($command -notmatch $installedPattern -or $command -notmatch $normalPattern) { throw 'OWNER_COMMAND_INCOMPATIBLE' }
    if (($command+' -NormalOperator') -match $installedPattern -or ($command+' -NormalOperator') -match $normalPattern) { throw 'UNEXPECTED_FLAG_ACCEPTED' }
}
Add-Type -Path (Join-Path $root 'src\NormalOperator.Native.cs')
$process=Get-Process -Id $PID
try { $proof=[McpCcNormalNative]::Inspect($process) } finally { $process.Dispose() }
if ($proof.pid -ne $PID -or $proof.startedUtcTicks -le 0 -or -not $proof.sid) { throw 'NATIVE_PROOF_INVALID' }
[pscustomobject]@{ result='PASS'; helperScope='PASS'; ownerCommandCompatibility='PASS';
    nativeCompileAndCurrentProcess='PASS'; currentInJob=$proof.inAnyJob; currentElevated=$proof.elevated;
    osIpcExchange='UNVERIFIED'; protectedHost='BLOCKED'; productionEnabled=$false } | ConvertTo-Json -Compress
