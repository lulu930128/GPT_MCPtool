param([string]$Engine,[string]$Root,[string]$RequestId,[string]$Digest,[string]$Point)
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
. $Engine
$powershell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if ($Point -eq 'between-renames') {
    function Move-Item {
        [CmdletBinding()]param([string]$LiteralPath,[string]$Destination)
        if ((Split-Path -Leaf $LiteralPath) -eq 'promote-dist') { [Environment]::Exit(92) }
        Microsoft.PowerShell.Management\Move-Item @PSBoundParameters
    }
}
if ($Point -eq 'before-reload-marker') {
    $script:writeJson=${function:Write-ComponentUpdateJson}
    function Write-ComponentUpdateJson([string]$Path,$Value) {
        if ((Split-Path -Leaf $Path) -eq 'reload-requested.json') { [Environment]::Exit(93) }
        & $script:writeJson -Path $Path -Value $Value
    }
}
$build={param($stageDist,$childJournalRoot)
    if ($Point -eq 'after-intent') { [Environment]::Exit(91) }
    if ($Point -eq 'finite-timeout' -or $Point -eq 'finite-parent-exit') {
        if ($Point -eq 'finite-parent-exit') {
            Add-Type -Path (Join-Path (Split-Path -Parent $Engine) '../../codex_bridge/scripts/DailyLifecycle.Native.cs')
            Add-Type -TypeDefinition 'using System; using System.Threading; public static class FixtureExitTimer { static Timer timer; public static void Start() { timer = new Timer(_ => Environment.Exit(94), null, 1000, Timeout.Infinite); } }'
            [FixtureExitTimer]::Start()
        }
        Invoke-ComponentUpdateProcess -Executable $powershell -Arguments '-NoProfile -NonInteractive -Command "Start-Sleep -Seconds 30"' -WorkingDirectory $Root -TimeoutMs $(if($Point -eq 'finite-timeout'){250}else{60000}) -ChildJournalRoot $childJournalRoot | Out-Null
    }
    Write-ComponentUpdateJson -Path (Join-Path $stageDist 'identity.json') -Value @{version='1.1';buildId='2222222222222222'}
}
$identity={param($distRoot) Read-ComponentUpdateJson (Join-Path $distRoot 'identity.json')}
$reload={
    Write-ComponentUpdateJson -Path (Join-Path $Root 'reload-called.json') -Value @{called=$true}
    Write-ComponentUpdateJson -Path (Join-Path $Root 'loaded.json') -Value @{ready=$true;version='1.1';buildId='2222222222222222'}
    if ($Point -eq 'reload-response-lost') { throw 'UPDATE_LIFECYCLE_RESULT_UNCERTAIN' }
}
$observe={Read-ComponentUpdateJson (Join-Path $Root 'loaded.json')}
$result=Invoke-NodeSourceUpdate -ComponentRoot $Root -ComponentId fixture -SourcePaths @('src') -Action Update -RequestId $RequestId -VersionId v1 -ExpectedSourceDigest $Digest -Build $build -Identity $identity -Reload $reload -Observe $observe -Preflight { [pscustomobject]@{allowed=$true} }
$result | ConvertTo-Json -Depth 12
if ($result.phase -eq 'ACCEPTED') { exit 0 }
exit 1
