param([string]$OutputRoot)
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$source=Split-Path -Parent $PSScriptRoot
$workspace=Split-Path -Parent $source
$fixtureBase=Join-Path $source '.tmp'
# Existing discovery tests intentionally reject TEMP workspaces. Use a new owner-local
# fixture rather than weakening that production rule or editing unrelated test semantics.
if(-not $OutputRoot){$OutputRoot=Join-Path $fixtureBase ('r1-isolated-'+[guid]::NewGuid().ToString('N'))}
$OutputRoot=[IO.Path]::GetFullPath($OutputRoot)
if((Split-Path -Parent $OutputRoot) -ine $fixtureBase -or (Split-Path -Leaf $OutputRoot) -notmatch '^r1-isolated-[a-f0-9]{32}$' -or (Test-Path -LiteralPath $OutputRoot)){throw 'NEW_ISOLATED_FIXTURE_REQUIRED'}
$candidate=Join-Path $OutputRoot 'codex_bridge'
$cc=Join-Path $OutputRoot 'mcp_control_center'
New-Item -ItemType Directory -Path $candidate,$cc | Out-Null
$before=(& node (Join-Path $source 'scripts\runtime-build-id.mjs')).Trim()
if($LASTEXITCODE -ne 0){throw 'LIVE_BUILD_READ_FAILED'}
# Copy only source/dependency allowlists. Never copy settings, tokens, policy, data or .tmp.
foreach($dir in @('src','tests','scripts','web','control-center','node_modules')){
    & robocopy.exe (Join-Path $source $dir) (Join-Path $candidate $dir) /E /XJ /R:0 /W:0 /NFL /NDL /NJH /NJS | Out-Null
    if($LASTEXITCODE -ge 8){throw "FIXTURE_COPY_FAILED: $dir"}
}
foreach($file in @('package.json','package-lock.json','tsconfig.json')){Copy-Item -LiteralPath (Join-Path $source $file) -Destination (Join-Path $candidate $file)}
foreach($dir in @('src','tests','scripts','config')){
    & robocopy.exe (Join-Path $workspace "mcp_control_center\$dir") (Join-Path $cc $dir) /E /XJ /R:0 /W:0 /NFL /NDL /NJH /NJS | Out-Null
    if($LASTEXITCODE -ge 8){throw "FIXTURE_COPY_FAILED: cc/$dir"}
}
$results=@()
Push-Location $candidate
try {
    $steps=@(
        @{name='stage-ui';exe='node';arguments=@('scripts/stage-self-reload-ui.mjs','--isolated-candidate')},
        @{name='npm-test';exe='npm.cmd';arguments=@('test')},
        @{name='http-smoke';exe='npm.cmd';arguments=@('run','smoke:http')},
        @{name='widget-check';exe='npm.cmd';arguments=@('run','widget:check')},
        @{name='native-handle';exe='powershell.exe';arguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File','tests/test-owned-process.ps1')},
        @{name='controller';exe='powershell.exe';arguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File','tests/test-runtime-control.ps1')},
        @{name='build-id';exe='powershell.exe';arguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File','tests/test-runtime-build-id.ps1')},
        @{name='cc-owner';exe='powershell.exe';arguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File','../mcp_control_center/tests/test-self-reload.ps1')},
        @{name='installed-mapping';exe='powershell.exe';arguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File','../mcp_control_center/tests/test-installed-release.ps1')}
        @{name='installed-binding';exe='powershell.exe';arguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File','tests/test-installed-binding.ps1')}
    )
    foreach($step in $steps){
        $log=Join-Path $OutputRoot ($step.name+'.log')
        # Windows PowerShell treats native stderr as ErrorRecords. Preserve the actual
        # failed step and exit code before fail-fast, rather than losing it from result.json.
        try {$ErrorActionPreference='Continue'; & $step.exe @($step.arguments) *> $log; $code=$LASTEXITCODE}
        finally {$ErrorActionPreference='Stop'}
        $results+=[pscustomobject]@{name=$step.name;exitCode=$code;log=$log}
        Write-Output ($step.name+': '+$(if($code -eq 0){'PASS'}else{'FAIL'}))
        if($code -ne 0){throw ('ISOLATED_STEP_FAILED: '+$step.name)}
    }
} finally {
    Pop-Location
    $after=(& node (Join-Path $source 'scripts\runtime-build-id.mjs')).Trim()
    $readExit=$LASTEXITCODE
    [pscustomobject]@{candidate=$candidate;liveCanonicalBefore=$before;liveCanonicalAfter=$after;liveCanonicalUnchanged=($readExit -eq 0 -and $before -ceq $after);
        host='HOST_NOT_VERIFIED';g1='PARTIAL';steps=$results}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $OutputRoot 'result.json') -Encoding UTF8
    Write-Output ('Evidence: '+$OutputRoot)
    if($readExit -ne 0 -or $before -cne $after){throw 'LIVE_CANONICAL_CHANGED'}
}
