Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$assertions = 0

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "Assertion failed: $Message" }
    $script:assertions++
}

$cases = @(
    @{ id='project_reading'; script='project_reading\scripts\runtime-control.ps1'; mutex='Local\ProjectReadingMcpRuntimeControl' },
    @{ id='omi_search'; script='OMI_search\scripts\runtime-control.ps1'; mutex='Local\OmiSearchMcpRuntimeControl' },
    @{ id='japanese_study'; script='japanese_study\scripts\runtime-control.ps1'; mutex='Local\JapaneseStudyMcpRuntimeControl' },
    @{ id='personal_asset_os'; script='personal-asset-os\scripts\runtime-control.ps1'; mutex='Local\PersonalAssetOsRuntimeControl' },
    @{ id='english_study'; script='english_study\scripts\runtime-control.ps1'; mutex='Local\McpComponent.english_study.Lifecycle' }
)

foreach ($case in $cases) {
    $mutex = New-Object Threading.Mutex($false, $case.mutex)
    $acquired = $false
    try {
        try { $acquired = $mutex.WaitOne(0, $false) }
        catch [Threading.AbandonedMutexException] { $acquired = $true }
        Assert-True $acquired "$($case.id) isolated test acquires the component mutex"
        $output = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $workspaceRoot $case.script) -Action Status 2>&1)
        $exitCode = $LASTEXITCODE
        $document = ($output -join [Environment]::NewLine) | ConvertFrom-Json
        Assert-True ($exitCode -ne 0 -and [string]$document.errorCode -eq 'ACTION_BUSY') "$($case.id) rejects the concurrent lifecycle action with ACTION_BUSY"
        Assert-True ([string]$document.action -eq 'Status' -and -not [bool]$document.ok) "$($case.id) returns a bounded failed controller contract"
    }
    finally {
        if ($acquired) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

[pscustomobject]@{ ok=$true; components=$cases.Count; assertions=$assertions } | ConvertTo-Json -Depth 3
