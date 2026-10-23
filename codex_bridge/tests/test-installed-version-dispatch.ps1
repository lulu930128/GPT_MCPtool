# Executes the actual entrypoint version gate in an isolated in-process runspace.
# No controller invocation, module loading, process launch, or runtime mutation.
param([string]$ControllerPath=(Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\runtime-control.ps1'))
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$path=$ControllerPath
$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
if($errors){throw 'CONTROLLER_PARSE_FAILED'}
$gates=@($ast.FindAll({param($node)
    $node -is [Management.Automation.Language.IfStatementAst] -and
    $node.Clauses[0].Item1.Extent.Text -match '^\$releaseVersion\s+-'
},$true))
if($gates.Count -ne 1){throw 'VERSION_GATE_NOT_UNIQUE'}
$checks=0
foreach($version in @(2,3,4,5,6)){
    foreach($action in @('Status','SelfTest','EnsureRunning')){
        $runspace=[PowerShell]::Create()
        try {
            $scriptText='param($releaseVersion,$Action)'+[Environment]::NewLine+$gates[0].Extent.Text+
                [Environment]::NewLine+'[pscustomobject]@{dispatch="CONTINUE_TO_EXISTING_BINDING_GATES"}|ConvertTo-Json'
            $null=$runspace.AddScript($scriptText).AddArgument($version).AddArgument($action)
            $output=$runspace.Invoke()
            if($runspace.HadErrors){throw 'ISOLATED_GATE_EXECUTION_FAILED'}
            $result=($output -join [Environment]::NewLine)|ConvertFrom-Json
            if($version -in @(3,4,5)){
                if($result.dispatch -cne 'CONTINUE_TO_EXISTING_BINDING_GATES'){throw 'SUPPORTED_RELEASE_NOT_DISPATCHED'}
            }elseif($result.code -cne 'INSTALLED_LIFECYCLE_BINDINGS_REQUIRED' -or $result.componentLaunches -ne 0){throw 'UNSUPPORTED_RELEASE_DISPATCHED'}
            $checks++
        }finally {$runspace.Dispose()}
    }
}
[pscustomobject]@{ok=$true;checks=$checks;dispatch='ACTUAL_ENTRYPOINT_VERSION_GATE';activation='NOT_TESTED';runtimeTouched=$false}|ConvertTo-Json
