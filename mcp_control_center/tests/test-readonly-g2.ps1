Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$native=Join-Path $root 'src\ReadOnlyG2.Native.cs'
$module=Join-Path $root 'src\McpControlCenter.ReadOnlyG2.psm1'
$source=Get-Content -LiteralPath $native -Raw -Encoding UTF8
$fixture=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'ReadOnlyG2.Check.cs') -Raw -Encoding UTF8
Add-Type -TypeDefinition ($source+"`n"+$fixture) -ReferencedAssemblies System.Web.Extensions,System.Core -ErrorAction Stop
$checks=[McpCc.ReadOnlyG2.Fixture]::Run()
$tokens=$null;$parseErrors=$null
$null=[Management.Automation.Language.Parser]::ParseFile($module,[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count) { throw 'G2_MODULE_SYNTAX_FAILED' }
Import-Module $module -Force
$denied=$false
try { New-McpCcReadOnlyG2Owner | Out-Null } catch { if ($_.Exception.Message -ceq 'NO_PROTECTED_INSTALL') { $denied=$true } else { throw } }
if (-not $denied) { throw 'WRITABLE_CHECKOUT_PROMOTED' }
$components=@()
foreach ($id in [McpCc.ReadOnlyG2.Contract]::Ids) {
    $components += [pscustomobject]@{id=$id;status='Ready';checkedAt=[DateTimeOffset]::UtcNow.ToString('o');capabilities=@('restart_core');payload='private';pid=123;healthUrl='private'}
}
$snapshot=ConvertTo-McpCcReadOnlyG2Snapshot ([pscustomobject]@{components=$components})
if ($snapshot -isnot [McpCc.ReadOnlyG2.Snapshot]) { throw 'PROJECTION_FAILED' }
$text=Get-Content -LiteralPath $module -Raw -Encoding UTF8
if ($text -match 'Invoke-McpCcComponentAction|Write-McpCc|Save-McpCc|Start-Process|Stop-Process|control-center\.ps1') { throw 'MUTATION_SOURCE_REACHABLE' }
if ($source -match 'Process\.Start\s*\(|Process\.Kill\s*\(|SetAccessControl|WriteAllText|WriteAllBytes') { throw 'NATIVE_MUTATION_SOURCE_REACHABLE' }
[pscustomobject]@{ok=$true;checks=($checks+4);evidenceScope='ISOLATED_FIXTURE_ONLY';productionPipeUsed=$false;ownerIdentity='NOT_VERIFIED';trayLaunch='NOT_ACTIVATED';protectedBootstrap='MANUAL_PENDING';mutationEnabled=$false} | ConvertTo-Json -Compress
