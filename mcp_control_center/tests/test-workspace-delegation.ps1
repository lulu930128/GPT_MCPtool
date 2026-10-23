Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$core=Join-Path $PSScriptRoot '..\src\McpControlCenter.Core.psm1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($core,[ref]$tokens,[ref]$errors)
if($errors.Count) {throw 'CORE_SYNTAX_FAILED'}
$function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Invoke-McpCcComponentAction'},$true)
. ([scriptblock]::Create($function.Extent.Text))
# Exercise the real canonical delegation body. Only its IO dependencies are fake;
# no import bootstrap, production mutex, component controller or child process.
function Get-McpCcComponent { param($Manifest,$Id) return [pscustomobject]@{resolvedRoot=$PSScriptRoot} }
function Get-McpCcComponentActionBinding {
    param($Component,$Action)
    return [pscustomobject]@{semanticAction='reload_runtime';manifestAction='reload_runtime';runtimeMode='component-controller';standardArguments=@('-Action','ReloadRuntime');actionSpec=[pscustomobject]@{kind='powershell';path='test-workspace-delegation.ps1'}}
}
function Resolve-McpCcChildPath { param($Root,$RelativePath,$Label) return $PSCommandPath }
$script:executions=0
function Invoke-McpCcBoundedPowerShell {
    param($ScriptPath,$Arguments,$WorkingDirectory,$RuntimeRoot,$TimeoutSeconds,$MaxCapturedOutputBytes)
    if(($Arguments -join ',') -cne '-Action,ReloadRuntime') {throw 'WRONG_FIXED_ACTION'}
    $script:executions++
    return [pscustomobject]@{processId=123;exitCode=0;stdout='{"ok":true,"action":"ReloadRuntime"}'}
}
function Assert-McpCcControllerActionResult {param($Document,$ExpectedAction) if($Document.action -cne $ExpectedAction){throw 'WRONG_ACTION'} }
function ConvertTo-McpCcSafeObject {param($Value) return $Value}
$value=Invoke-McpCcComponentAction -Manifest ([pscustomobject]@{schemaVersion=3}) -ComponentId workspace_local_fixture -Action reload_runtime -RuntimeRoot $PSScriptRoot -ActionTimeoutSeconds 1
if($value.processId -ne 123 -or -not $value.delegated -or $script:executions -ne 1) {throw 'CANONICAL_DELEGATION_FAILED'}
# Restore the real pure binding helpers to verify the checked-in registry's exact
# action mapping. Read source descriptors only; never call a live controller.
foreach($name in @('Get-McpCcObjectProperty','Get-McpCcRuntimeMode','Get-McpCcComponentActionBinding')) {
    $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true)
    . ([scriptblock]::Create($definition.Extent.Text))
}
$script:ControllerCapabilities=@('ensure_running','repair_connectivity','restart_core','reload_runtime','shutdown_runtime','show_diagnostic_tray')
$registryPath=Join-Path $PSScriptRoot '..\config\registry.json'
$registry=Get-Content -LiteralPath $registryPath -Raw -Encoding UTF8 | ConvertFrom-Json
if($registry.schemaVersion -ne 3) {throw 'SOURCE_REGISTRY_REQUIRED'}
$ids=@('codex_bridge','omi_search','japanese_study','memory_core','personal_asset_os','english_study','listening_audio')
$checks=3
foreach($id in $ids) {
    $entries=@($registry.components | Where-Object {$_.id -ceq $id})
    if($entries.Count -ne 1) {throw 'FIXED_TARGET_MISSING'}
    $entry=$entries[0]
    $componentRoot=[IO.Path]::GetFullPath((Join-Path (Split-Path $registryPath) $entry.root))
    $descriptor=Get-Content -LiteralPath (Join-Path $componentRoot $entry.descriptor) -Raw -Encoding UTF8 | ConvertFrom-Json
    if($descriptor.id -cne $id -or $descriptor.runtimeMode -cne 'component-controller' -or
        $descriptor.lifecycle.controller.path -cne 'scripts\runtime-control.ps1' -or
        $descriptor.lifecycle.controller.kind -cne 'powershell') {throw 'EXACT_CONTROLLER_REQUIRED'}
    $component=[pscustomobject]@{id=$id;runtimeMode=$descriptor.runtimeMode;capabilities=$descriptor.capabilities;actions=@{reload_runtime=$descriptor.lifecycle.controller}}
    $binding=Get-McpCcComponentActionBinding -Component $component -Action reload_runtime
    if($binding.manifestAction -cne 'reload_runtime' -or ($binding.standardArguments -join ',') -cne '-Action,ReloadRuntime') {throw 'FIXED_MAPPING_FAILED'}
    $checks++
}
# The old rollback manifest uses the existing fixed semantic alias; it is not
# the production registry and is never launched by this test.
$legacy=Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\config\components.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach($component in @($legacy.components | Where-Object {$_.runtimeMode -ceq 'legacy-tray'})) {
    $binding=Get-McpCcComponentActionBinding -Component $component -Action reload_runtime
    if($binding.manifestAction -cne 'restart' -or $binding.standardArguments.Count -ne 0) {throw 'LEGACY_MAPPING_FAILED'}
    $checks++
}
[pscustomobject]@{ok=$true;checks=$checks;canonicalBody=$true;fixedTargets=$ids.Count;controller='MOCK';liveRestart=$false} | ConvertTo-Json -Compress
