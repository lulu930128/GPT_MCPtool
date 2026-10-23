# Isolated parser/source/read-only snapshot verification; no Tray/host/marker execution.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'WINDOWS_POWERSHELL_51_REQUIRED' }
$root=Split-Path -Parent $PSScriptRoot
$preview=Join-Path $root 'scripts\preview-normal-operator-source.ps1'
$tokens=$null; $parseErrors=$null
foreach ($path in @($preview,$PSCommandPath)) {
    $null=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$parseErrors)
    if ($parseErrors.Count) { throw 'PS51_PARSE_FAILED' }
}
foreach ($text in @('$a ?? $b','$a ? $b : $c','Get-Date && Get-Date','Get-Date || Get-Date')) {
    $null=[Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$parseErrors)
    if (-not $parseErrors.Count) { throw 'PS7_SYNTAX_NOT_REJECTED' }
}
$source=Get-Content -LiteralPath $preview -Raw -Encoding UTF8
foreach ($forbidden in @('Start-Process','ProcessStartInfo','Invoke-Expression','Import-Module','Add-Type',
    'Set-Content','Add-Content','Out-File','WriteAll','Set-Acl','NamedPipe','UseShellExecute')) {
    if ($source.Contains($forbidden)) { throw 'SOURCE_SIDE_EFFECT_FOUND' }
}
$output=@(& $preview)
if ($output.Count -ne 1 -or $output[0] -isnot [string]) { throw 'OUTPUT_NOT_SINGLE_JSON' }
if ([Text.Encoding]::UTF8.GetByteCount($output[0]) -gt 8192) { throw 'OUTPUT_NOT_BOUNDED' }
$value=$output[0] | ConvertFrom-Json
if ($value.contract -cne 'normal-operator-source-v1' -or @($value.files).Count -ne 11 -or
    @($value.PSObject.Properties).Count -ne 2) { throw 'MANIFEST_INVALID' }
if (@($value.files.path | Select-Object -Unique).Count -ne 11) { throw 'DUPLICATE_PATH' }
foreach ($file in $value.files) {
    if (@($file.PSObject.Properties).Count -ne 2 -or $file.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $file.path -notmatch '^(mcp_control_center|codex_bridge)\\') { throw 'FILE_ENTRY_INVALID' }
    $path=Join-Path (Split-Path -Parent $root) $file.path
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $file.sha256) { throw 'HASH_MISMATCH' }
}
foreach ($argument in @('-Apply','-ExpectedHash','-Path','-Grant')) {
    $caught=$null
    try { $null=& $preview $argument } catch { $caught=$_.Exception.Message }
    if ($caught -cne 'SOURCE_PREVIEW_ARGUMENTS_REJECTED') { throw 'UNEXPECTED_ARGUMENT_ACCEPTED' }
}
$gate=Get-Content -LiteralPath (Join-Path $root 'src\McpControlCenter.NormalOperator.psm1') -Raw -Encoding UTF8
if (-not $gate.Contains("throw 'BLOCKED_CANONICAL_HOST_AUTHORITY_REQUIRED'")) { throw 'FORMAL_GATE_CHANGED' }
[pscustomobject]@{result='PASS_SOURCE_ONLY';files=11;parser='Windows PowerShell 5.1';
    configWritten=$false;childDispatched=$false;formalHost='BLOCKED'} | ConvertTo-Json -Compress
