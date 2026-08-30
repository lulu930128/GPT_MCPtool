Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("mcp-ownership-stop-race-" + [Guid]::NewGuid().ToString('N'))
$utf8 = New-Object Text.UTF8Encoding($false)
$assertions = 0

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "Assertion failed: $Message" }
    $script:assertions++
}

$cases = @(
    @{ id='project_reading'; module='project_reading\scripts\project-reading-runtime.psm1'; stop='Stop-PrOwnedRole'; resolve='Resolve-PrRoleOwnership'; descendants=$null; role='tunnel'; context={ param($Root,$Exe) [pscustomobject]@{ tunnelPidFile=Join-Path $Root 'runtime.pid'; tunnelOwnerFile=Join-Path $Root 'runtime.owner.json'; tunnelHealthPort=19201; tunnelClientPath=$Exe; tunnelProfile='fixture-role' } } },
    @{ id='omi_search'; module='OMI_search\scripts\omi-search-runtime.psm1'; stop='Stop-OmiOwnedRole'; resolve='Resolve-OmiRoleOwnership'; descendants=$null; role='tunnel'; context={ param($Root,$Exe) [pscustomobject]@{ tunnelPidFile=Join-Path $Root 'runtime.pid'; tunnelOwnerFile=Join-Path $Root 'runtime.owner.json'; tunnelHealthPort=19202; tunnelClientPath=$Exe; tunnelProfile='fixture-role' } } },
    @{ id='japanese_study'; module='japanese_study\scripts\japanese-study-runtime.psm1'; stop='Stop-JsOwnedRole'; resolve='Resolve-JsRoleOwnership'; descendants='Get-JsOwnedDescendants'; role='tunnel'; context={ param($Root,$Exe) [pscustomobject]@{ tunnelPidFile=Join-Path $Root 'runtime.pid'; tunnelOwnerFile=Join-Path $Root 'runtime.owner.json'; tunnelHealthPort=19203; tunnelClientPath=$Exe; tunnelIdentity='fixture-role' } } },
    @{ id='personal_asset_os'; module='personal-asset-os\scripts\personal-asset-os-runtime.psm1'; stop='Stop-PaosOwnedRole'; resolve='Resolve-PaosRoleOwnership'; descendants='Get-PaosOwnedDescendants'; role='tunnel'; context={ param($Root,$Exe) [pscustomobject]@{ tunnelPidFile=Join-Path $Root 'runtime.pid'; tunnelOwnerFile=Join-Path $Root 'runtime.owner.json'; tunnelHealthPort=19204; tunnelClientPath=$Exe; tunnelIdentity='fixture-role' } } },
    @{ id='english_study'; module='english_study\scripts\component-runtime.psm1'; stop='Stop-EnglishStudyRole'; resolve='Get-EnglishStudyRoleState'; descendants='Get-EnglishStudyOwnedDescendants'; role='tunnel'; context={ param($Root,$Exe) [pscustomobject]@{ tunnelPidFile=Join-Path $Root 'runtime.pid'; tunnelOwnerFile=Join-Path $Root 'runtime.owner.json'; tunnelHealthPort=19205; tunnelClientPath=$Exe; tunnelIdentity='fixture-role' } } }
)

try {
    New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
    foreach ($case in $cases) {
        $fixture = $null
        $module = $null
        try {
            $caseRoot = Join-Path $testRoot $case.id
            New-Item -ItemType Directory -Force -Path $caseRoot | Out-Null
            $fixture = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 120') -WindowStyle Hidden -PassThru
            $native = Get-Process -Id $fixture.Id -ErrorAction Stop
            $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $($fixture.Id)" -ErrorAction Stop
            $path = [string]$native.Path
            $actualStart = $native.StartTime.ToUniversalTime().ToString('o')
            $wrongStart = [DateTime]::Parse($actualStart).ToUniversalTime().AddDays(-1).ToString('o')
            $context = & $case.context $caseRoot $path
            [IO.File]::WriteAllText($context.tunnelPidFile, [string]$fixture.Id, $utf8)
            $owner = [ordered]@{ schemaVersion=1; role='tunnel'; pid=$fixture.Id; executablePath=$path; startTimeUtc=$wrongStart; identity='fixture-role'; recordedAt=[DateTime]::UtcNow.ToString('o') }
            [IO.File]::WriteAllText($context.tunnelOwnerFile, ($owner | ConvertTo-Json -Compress), $utf8)
            $expected = [pscustomobject]@{ ProcessId=$fixture.Id; ParentProcessId=[int]$cim.ParentProcessId; ExecutablePath=$path; StartTimeUtc=$wrongStart; Depth=0 }

            $module = Import-Module (Join-Path $workspaceRoot $case.module) -Force -PassThru
            $errorMessage = & $module {
                param($Context,$Role,$StopFunction,$ResolveFunction,$DescendantsFunction,$FixtureProcessId,$Expected)
                $script:StopRacePid = [int]$FixtureProcessId
                $script:StopRaceExpected = $Expected
                $script:StopRaceResolveFunction = $ResolveFunction
                if ($ResolveFunction -eq 'Get-EnglishStudyRoleState') {
                    Set-Item -Path ("Function:" + $ResolveFunction) -Value { [pscustomobject]@{ state='Owned'; canMutate=$true; managedPid=$script:StopRacePid; listenerPid=$script:StopRacePid; relation='Self' } }
                }
                elseif ($ResolveFunction -eq 'Resolve-PrRoleOwnership' -or $ResolveFunction -eq 'Resolve-OmiRoleOwnership') {
                    Set-Item -Path ("Function:" + $ResolveFunction) -Value { [pscustomobject]@{ state='OwnedReady'; canMutate=$true; pid=$script:StopRacePid; listenerPid=$script:StopRacePid } }
                }
                else {
                    Set-Item -Path ("Function:" + $ResolveFunction) -Value { [pscustomobject]@{ state='OwnedReady'; canMutate=$true; managedPid=$script:StopRacePid; listenerPid=$script:StopRacePid; relation='Self' } }
                }
                if (-not [string]::IsNullOrWhiteSpace([string]$DescendantsFunction)) {
                    Set-Item -Path ("Function:" + $DescendantsFunction) -Value { return @($script:StopRaceExpected) }
                }
                try { & $StopFunction -Context $Context -Role $Role; return $null }
                catch { return [string]$_.Exception.Message }
            } $context $case.role $case.stop $case.resolve $case.descendants $fixture.Id $expected

            Assert-True (-not [string]::IsNullOrWhiteSpace($errorMessage) -and $errorMessage.StartsWith('OWNERSHIP_CHANGED:', [StringComparison]::Ordinal)) "$($case.id) rejects a process instance changed after resolve; actual=$errorMessage"
            Assert-True ($null -ne (Get-Process -Id $fixture.Id -ErrorAction SilentlyContinue)) "$($case.id) leaves the reused/unrelated process alive"
            Assert-True ((Test-Path -LiteralPath $context.tunnelPidFile) -and (Test-Path -LiteralPath $context.tunnelOwnerFile)) "$($case.id) preserves ownership evidence after stop rejection"
        }
        finally {
            if ($null -ne $module) { Remove-Module $module -Force -ErrorAction SilentlyContinue }
            if ($null -ne $fixture) {
                $current = Get-Process -Id $fixture.Id -ErrorAction SilentlyContinue
                if ($null -ne $current -and $current.StartTime.ToUniversalTime().ToString('o') -eq $fixture.StartTime.ToUniversalTime().ToString('o')) {
                    $current.Kill(); $null = $current.WaitForExit(5000); $current.Dispose()
                }
                $fixture.Dispose()
            }
        }
    }
    [pscustomobject]@{ ok=$true; components=$cases.Count; assertions=$assertions } | ConvertTo-Json -Depth 3
}
finally {
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
