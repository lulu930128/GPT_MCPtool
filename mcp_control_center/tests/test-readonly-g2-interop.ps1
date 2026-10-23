# DEPRECATED historical G2 prototype; not composed by the tray.
# Current path/tests: WorkspaceLocal.Native.cs and test-workspace-local.ps1.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$source=Get-Content -LiteralPath (Join-Path $root 'src\ReadOnlyG2.Native.cs') -Raw -Encoding UTF8
$fixture=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'ReadOnlyG2.Check.cs') -Raw -Encoding UTF8
Add-Type -TypeDefinition ($source+"`n"+$fixture) -ReferencedAssemblies System.Web.Extensions,System.Core -ErrorAction Stop
$name='mcpcc-g2-fixture-'+[Guid]::NewGuid().ToString('N')
$owner=[McpCc.ReadOnlyG2.Fixture]::OpenForNode($name)
try {
    & node (Join-Path $root '..\project_reading\scripts\smoke-readonly-g2-interop.mjs') $name
    if ($LASTEXITCODE -ne 0) { throw 'NODE_INTEROP_FAILED' }
} finally { $owner.Dispose() }
