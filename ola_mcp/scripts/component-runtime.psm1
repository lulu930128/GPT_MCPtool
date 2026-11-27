Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

function Invoke-ComponentRuntimeAction {
    param([Parameter(Mandatory=$true)][string]$Action)
    $component = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $workspace = Split-Path $component -Parent
    $dir = Join-Path $component '.tmp'
    $profileDir = Join-Path $component '.tunnel-client'
    $context = [pscustomobject]@{
        projectRoot=$component
        runtimeDir=$dir
        tunnelProfile='open-intel-atlas'
        tunnelProfileDir=$profileDir
        tunnelProfilePath=(Join-Path $profileDir 'open-intel-atlas.yaml')
        tunnelClientPath=(Join-Path $workspace 'project_reading\vendor\tunnel-client\tunnel-client.exe')
        tunnelHealthPort=18949
        tunnelHealthUrl='http://127.0.0.1:18949'
        tunnelPidFile=(Join-Path $dir 'tunnel-client.pid')
        tunnelOwnerFile=(Join-Path $dir 'tunnel-client.owner.json')
        tunnelLogFile=(Join-Path $dir 'tunnel-client.log')
        secretPath=(Join-Path $component '.secrets\control-plane-api-key.dpapi')
        keyStorePath=(Join-Path $workspace 'project_reading\scripts\key-store.ps1')
    }
    Import-Module (Join-Path $workspace 'OMI_search\scripts\omi-search-runtime.psm1') -ErrorAction Stop
    $check = {
        $runtime = Invoke-RestMethod -Uri 'http://127.0.0.1:8790/api/v1/runtime' -TimeoutSec 3
        $runtime.service -eq 'open-intel-atlas' -and $runtime.status -eq 'running' -and $runtime.base_url -eq 'http://127.0.0.1:8790'
    }
    Invoke-ComponentTunnelLifecycle -Context $context -Action $Action -CheckUpstream $check
}
Export-ModuleMember -Function Invoke-ComponentRuntimeAction
