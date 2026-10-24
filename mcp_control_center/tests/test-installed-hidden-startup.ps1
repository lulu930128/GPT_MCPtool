param([string]$SourceRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$checks = 0
function Check([bool]$Value, [string]$Message) {
    if (-not $Value) { throw $Message }; $script:checks++
}
function Read-Ast([string]$Relative) {
    $errors = $null; $tokens = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $SourceRoot $Relative), [ref]$tokens, [ref]$errors)
    Check ($errors.Count -eq 0) ('Parse: ' + $Relative)
    return $ast
}
function Find-Guard($Ast, [string]$Function, [string]$Field) {
    $fn = $Ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $Function }, $true)
    $guards = @($fn.FindAll({ param($n) $n -is [Management.Automation.Language.IfStatementAst] -and $n.Clauses[0].Item1.Extent.Text.Contains($Field) }, $true))
    Check ($guards.Count -eq 1) ('Unique guard: ' + $Function + '/' + $Field)
    return [scriptblock]::Create($guards[0].Extent.Text)
}
function Accepts([scriptblock]$Guard) {
    try { & $Guard; return $true } catch {
        if ($_.Exception.Message -notin @('INSTALLED_STARTUP_NOT_SELECTED', 'UPGRADE_STARTUP_NOT_SELECTED', 'INSTALLED_OWNER_UNKNOWN', 'EXACT_TRAY_OWNER_REQUIRED')) { throw }
        return $false
    }
}
$verifier = Read-Ast 'mcp_control_center\src\McpControlCenter.InstalledRelease.psm1'
$operator = Read-Ast 'codex_bridge\scripts\installed-release-operator.ps1'
$normal = Read-Ast 'mcp_control_center\src\McpControlCenter.NormalOperator.psm1'
$selection = Find-Guard $verifier 'Assert-McpCcInstalledSelection' '$link.TargetPath'
$upgrade = Find-Guard $operator 'Assert-InstalledUpgradeSelection' '$link.TargetPath'
$owner = Find-Guard $verifier 'Assert-McpCcInstalledSelection' '$cim.CommandLine'
$normalGuard = Find-Guard $normal 'Open-McpCcNormalInstalledContext' '$cim.CommandLine'
$normalFunction = $normal.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Open-McpCcNormalInstalledContext' }, $true)
$normalPattern = $normalFunction.Find({ param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$pattern' }, $true)
$ReleaseRoot = 'C:\Program Files\McpCcReleases\fixture-release'
$Previous = [pscustomobject]@{ root = $ReleaseRoot }
$Binding = [pscustomobject]@{ operatorSid = 'fixture-user' }
$ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$tray = Join-Path $ReleaseRoot 'mcp_control_center\scripts\tray.ps1'
$working = Join-Path $ReleaseRoot 'mcp_control_center'
$visible = '-NoProfile -File "' + $tray + '" -AutoReconcile'
$hidden = '-NoProfile -WindowStyle Hidden -File "' + $tray + '" -AutoReconcile'
$link = [pscustomobject]@{ TargetPath = $ps; Arguments = $visible; WorkingDirectory = $working }
foreach ($guard in @($selection, $upgrade)) {
    foreach ($arguments in @($visible, $hidden)) {
        $link.Arguments = $arguments
        Check (Accepts $guard) ('Valid shortcut: ' + $arguments)
    }
    foreach ($arguments in @(
        ($hidden + ' -ReplaceExisting'), ($hidden + ' -RuntimeRoot C:\other'),
        ($hidden + ' -ManifestPath C:\other.json'), ($hidden + ' -ProjectRoot C:\other'),
        ($hidden + ' -Command whoami'), ($hidden + ' -EncodedCommand AAAA'),
        ($hidden.Replace(' Hidden ', ' Normal ')), ($hidden.Replace(' Hidden ', ' Minimized ')),
        ($hidden.Replace('-NoProfile ', '-NoProfile -ExecutionPolicy Bypass ')),
        ($hidden.Replace('fixture-release', 'other-release')), ($hidden.Replace('"', '')),
        ($hidden.Replace(' -AutoReconcile', '')), ($hidden + ' '))) {
        $link.Arguments = $arguments
        Check (-not (Accepts $guard)) ('Reject shortcut: ' + $arguments)
    }
    $link.Arguments = $hidden; $link.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    Check (-not (Accepts $guard)) 'Reject wscript shortcut'
    $link.TargetPath = $ps; $link.WorkingDirectory = 'C:\other'
    Check (-not (Accepts $guard)) 'Reject shortcut working directory'
    $link.WorkingDirectory = $working
}
$sid = [pscustomobject]@{ ReturnValue = 0; Sid = $Binding.operatorSid }
$cim = [pscustomobject]@{ CommandLine = '' }
foreach ($executable in @($ps, ('"' + $ps + '"'))) {
    foreach ($arguments in @($visible, $hidden, $visible.Replace(' -AutoReconcile', ''), $hidden.Replace(' -AutoReconcile', ''))) {
        $cim.CommandLine = $executable + ' ' + $arguments
        Check (Accepts $owner) 'Accept selected startup and operator-launched owner'
    }
}
foreach ($arguments in @(
    ($hidden + ' -ReplaceExisting'), ($hidden + ' -RuntimeRoot C:\other'),
    ($hidden + ' -Command whoami'), ($hidden + ' -EncodedCommand AAAA'),
    ($hidden.Replace(' Hidden ', ' Normal ')), ($hidden.Replace('fixture-release', 'other-release')),
    ($hidden.Replace('"', '')), ($hidden.Replace('-NoProfile ', '')))) {
    $cim.CommandLine = '"' + $ps + '" ' + $arguments
    Check (-not (Accepts $owner)) ('Reject owner: ' + $arguments)
}
$cim.CommandLine = '"' + $ps + '" ' + $hidden
$sid.Sid = 'other-user'; Check (-not (Accepts $owner)) 'Reject owner SID mismatch'
$sid.Sid = $Binding.operatorSid; $sid.ReturnValue = 5
Check (-not (Accepts $owner)) 'Reject unknown owner SID'
$sid.ReturnValue = 0

# NORMAL owns another exact-process check. Cover it independently so a hidden
# tray cannot pass selection but silently lose its existing Host transport.
$expectedImage = $ps
. ([scriptblock]::Create($normalPattern.Extent.Text))
foreach ($arguments in @($visible, $hidden, $visible.Replace(' -AutoReconcile', ''), $hidden.Replace(' -AutoReconcile', ''))) {
    $cim.CommandLine = '"' + $ps + '" ' + $arguments
    Check (Accepts $normalGuard) 'NORMAL accepts the same supported tray commands'
}
foreach ($arguments in @(
    ($hidden + ' -ReplaceExisting'), ($hidden + ' -RuntimeRoot C:\other'),
    ($hidden + ' -Command whoami'), ($hidden + ' -EncodedCommand AAAA'),
    ($hidden.Replace(' Hidden ', ' Normal ')), ($hidden.Replace('fixture-release', 'other-release')),
    ($hidden.Replace('"', '')), ($hidden.Replace('-NoProfile ', '')))) {
    $cim.CommandLine = '"' + $ps + '" ' + $arguments
    Check (-not (Accepts $normalGuard)) ('NORMAL rejects altered owner: ' + $arguments)
}
$cim = $null
Check (-not (Accepts $normalGuard)) 'NORMAL rejects a missing owner'

# Execute only the actual Cutover shortcut property assignments against a TEMP
# shortcut. Never run the operator, tray, controllers, native Host or lifecycle.
$setters = @($operator.FindAll({ param($n)
    $n -is [Management.Automation.Language.AssignmentStatementAst] -and
    $n.Left.Extent.Text -in @('$link.TargetPath', '$link.Arguments', '$link.WorkingDirectory')
}, $true))
Check ($setters.Count -eq 3) 'Exactly three Cutover shortcut assignments'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('mcpcc-hidden-startup-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$shortcut = Join-Path $fixture 'fixture.lnk'
$shell = New-Object -ComObject WScript.Shell
try {
    $link = $shell.CreateShortcut($shortcut)
    foreach ($setter in $setters) { & ([scriptblock]::Create($setter.Extent.Text)) }
    Check ($link.Arguments -ceq $hidden) 'Cutover selects hidden startup'
    $link.Save()
    $link = $shell.CreateShortcut($shortcut)
    Check (Accepts $selection) 'Saved shortcut accepted by installed selection'
    Check (Accepts $upgrade) 'Saved shortcut remains upgradable'
} finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
[pscustomobject]@{ ok = $true; checks = $checks; scope = 'isolated source and TEMP shortcut'; productionTouched = $false; fixture = $fixture } | ConvertTo-Json
