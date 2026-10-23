# Read-only preview of the existing 11-file closure. Not an immutable trust anchor.
# stdout is a candidate manifest only; never write config, import code or launch a host.
param()
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
if ($args.Count -ne 0) { throw 'SOURCE_PREVIEW_ARGUMENTS_REJECTED' }
$handles=@()
$sha=$null
try {
    $managerRoot=Split-Path -Parent $PSScriptRoot
    $workspaceRoot=Split-Path -Parent $managerRoot
    $fixed=@('mcp_control_center\scripts\tray.ps1','mcp_control_center\scripts\normal-marker-operator.ps1',
        'mcp_control_center\src\McpControlCenter.NormalOperator.psm1','mcp_control_center\src\NormalOperator.Native.cs',
        'mcp_control_center\src\McpControlCenter.Core.psm1','mcp_control_center\src\McpControlCenter.InstalledRelease.psm1',
        'codex_bridge\src\powershell-approval\contract.ts','codex_bridge\src\powershell-approval\store.ts',
        'codex_bridge\src\powershell-approval\broker.ts','codex_bridge\src\powershell-approval\password.ts',
        'codex_bridge\src\powershell-approval\local-ui.ts')
    foreach ($relative in $fixed) {
        $path=Join-Path $workspaceRoot $relative
        if ($path.StartsWith('\\')) { throw 'SOURCE_PREVIEW_PATH_REJECTED' }
        $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if ($item -is [IO.DirectoryInfo] -or $item.Length -gt 1MB) { throw 'SOURCE_PREVIEW_FILE_REJECTED' }
        while ($null -ne $item) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'SOURCE_PREVIEW_REPARSE_REJECTED' }
            if ($item -is [IO.DirectoryInfo]) { $item=$item.Parent } else { $item=$item.Directory }
        }
        $handles+=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        if ($handles[-1].Length -gt 1MB) { throw 'SOURCE_PREVIEW_FILE_REJECTED' }
    }
    # Parse the formal gate as data. Never import/evaluate its protected-host code.
    $tokens=$null; $parseErrors=$null
    $gatePath=Join-Path $managerRoot 'src\McpControlCenter.NormalOperator.psm1'
    $ast=[Management.Automation.Language.Parser]::ParseFile($gatePath,[ref]$tokens,[ref]$parseErrors)
    if ($parseErrors.Count -ne 0) { throw 'SOURCE_PREVIEW_CLOSURE_MISMATCH' }
    $assignment=@($ast.FindAll({param($node)
        $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -ceq '$fixed'
    },$true))
    if ($assignment.Count -ne 1) { throw 'SOURCE_PREVIEW_CLOSURE_MISMATCH' }
    $strings=@($assignment[0].Right.FindAll({param($node)
        $node -is [Management.Automation.Language.StringConstantExpressionAst]
    },$true) | ForEach-Object { $_.Value })
    if (($strings -join "`n") -cne ($fixed -join "`n")) { throw 'SOURCE_PREVIEW_CLOSURE_MISMATCH' }
    $sha=[Security.Cryptography.SHA256]::Create()
    $files=@(for ($i=0; $i -lt $fixed.Count; $i++) {
        $digest=[BitConverter]::ToString($sha.ComputeHash($handles[$i])).Replace('-','').ToLowerInvariant()
        [ordered]@{path=$fixed[$i];sha256=$digest}
    })
    $json=[ordered]@{contract='normal-operator-source-v1';files=$files} | ConvertTo-Json -Depth 4 -Compress
    if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 8192) { throw 'SOURCE_PREVIEW_OUTPUT_LIMIT' }
    # Emit only after all checks succeed. No partial manifest on failure.
    $json
} catch {
    $known=@('SOURCE_PREVIEW_PATH_REJECTED','SOURCE_PREVIEW_FILE_REJECTED','SOURCE_PREVIEW_REPARSE_REJECTED',
        'SOURCE_PREVIEW_CLOSURE_MISMATCH','SOURCE_PREVIEW_OUTPUT_LIMIT')
    if ($_.Exception.Message -cin $known) { throw $_.Exception.Message }
    throw 'SOURCE_PREVIEW_READ_FAILED'
} finally {
    if ($null -ne $sha) { $sha.Dispose() }
    foreach ($handle in $handles) { $handle.Dispose() }
}
