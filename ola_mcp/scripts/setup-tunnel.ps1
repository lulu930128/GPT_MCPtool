param([ValidateSet('Init','SaveKey','KeyStatus','Doctor','SelfTest')][string]$Action='SelfTest',[string]$TunnelId=$env:OLA_TUNNEL_ID)
$ErrorActionPreference='Stop'
$component=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$workspace=Split-Path $component -Parent
$shared=Join-Path $workspace 'project_reading\scripts\tunnel.ps1'
$client=Join-Path $workspace 'project_reading\vendor\tunnel-client\tunnel-client.exe'
if ($Action -eq 'Init' -and (Test-Path -LiteralPath (Join-Path $component '.tunnel-client\open-intel-atlas.yaml'))) { throw 'OLA_PROFILE_ALREADY_EXISTS' }
& $shared -Action $Action -ProjectRoot $component -Profile 'open-intel-atlas' -TunnelId $TunnelId -TunnelClientPath $client -McpUrl 'http://127.0.0.1:8790/mcp' -HealthListenAddr '127.0.0.1:18949'
