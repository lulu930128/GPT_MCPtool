Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$PythonPath = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
$FingerprintScript = Join-Path $PSScriptRoot 'smoke-kgi-overlay.py'
$McpUrl = 'http://127.0.0.1:18876/mcp/'
$ProtocolVersion = '2025-06-18'

function Get-DatabaseFingerprint {
    $json = & $PythonPath -X utf8 $FingerprintScript --database-fingerprint
    if ($LASTEXITCODE -ne 0) { throw 'Database fingerprint failed.' }
    return ($json | ConvertFrom-Json)
}

function Invoke-McpRequest {
    param([hashtable]$Body, [string]$SessionId)
    $headers = @{ Accept = 'application/json, text/event-stream' }
    if (-not [string]::IsNullOrWhiteSpace($SessionId)) {
        $headers['Mcp-Session-Id'] = $SessionId
        $headers['Mcp-Protocol-Version'] = $ProtocolVersion
    }
    return Invoke-WebRequest -Uri $McpUrl -Method Post -Headers $headers `
        -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Depth 12 -Compress) `
        -TimeoutSec 60 -UseBasicParsing
}

$before = Get-DatabaseFingerprint
$sessionId = $null
try {
    $initialize = Invoke-McpRequest -Body @{
        jsonrpc = '2.0'; id = 1; method = 'initialize'
        params = @{
            protocolVersion = $ProtocolVersion
            capabilities = @{}
            clientInfo = @{ name = 'paos-kgi-readonly-smoke'; version = '1.0' }
        }
    } -SessionId ''
    $sessionId = [string]$initialize.Headers['Mcp-Session-Id']
    if ([string]::IsNullOrWhiteSpace($sessionId)) { throw 'MCP initialize returned no session id.' }

    Invoke-McpRequest -Body @{
        jsonrpc = '2.0'; method = 'notifications/initialized'; params = @{}
    } -SessionId $sessionId | Out-Null
    $toolListResponse = Invoke-McpRequest -Body @{
        jsonrpc = '2.0'; id = 2; method = 'tools/list'; params = @{}
    } -SessionId $sessionId
    $toolList = $toolListResponse.Content | ConvertFrom-Json
    $toolNames = @($toolList.result.tools | ForEach-Object { [string]$_.name })

    $overviewResponse = Invoke-McpRequest -Body @{
        jsonrpc = '2.0'; id = 3; method = 'tools/call'
        params = @{ name = 'get_asset_overview'; arguments = @{} }
    } -SessionId $sessionId
    $overview = ($overviewResponse.Content | ConvertFrom-Json).result.structuredContent

    $positionsResponse = Invoke-McpRequest -Body @{
        jsonrpc = '2.0'; id = 4; method = 'tools/call'
        params = @{ name = 'list_asset_positions'; arguments = @{} }
    } -SessionId $sessionId
    $positionResult = ($positionsResponse.Content | ConvertFrom-Json).result.structuredContent
    $kgiPositions = @($positionResult.positions | Where-Object {
        [string]$_.position_source -eq 'kgi_broker'
    })

    $after = Get-DatabaseFingerprint
    $checks = [ordered]@{
        session_established = -not [string]::IsNullOrWhiteSpace($sessionId)
        seven_read_only_tools_visible = $toolNames.Count -eq 7
        overview_tool_visible = $toolNames -contains 'get_asset_overview'
        positions_tool_visible = $toolNames -contains 'list_asset_positions'
        overview_broker_usable = @('complete', 'partial') -contains [string]$overview.broker.status
        overview_broker_schema_v2 = [string]$overview.broker.schema_version -eq 'paos.broker_valuation.v2'
        overview_market_statuses_present = @($overview.broker.markets).Count -gt 0
        overview_broker_applied = [decimal]$overview.metrics.broker_market_value -gt 0
        positions_broker_usable = @('complete', 'partial') -contains [string]$positionResult.broker.status
        broker_positions_visible = $kgiPositions.Count -gt 0
        database_table_counts_unchanged = [string]$before.table_counts_hash -eq [string]$after.table_counts_hash
        database_file_unchanged = [string]$before.database_file_hash -eq [string]$after.database_file_hash
    }
    $ok = -not ($checks.Values -contains $false)
    [pscustomobject]@{
        ok = $ok
        tool_count = $toolNames.Count
        broker_position_count = $kgiPositions.Count
        checks = $checks
    } | ConvertTo-Json -Depth 5
    if (-not $ok) { exit 1 }
}
finally {
    if (-not [string]::IsNullOrWhiteSpace($sessionId)) {
        try {
            Invoke-WebRequest -Uri $McpUrl -Method Delete -Headers @{
                Accept = 'application/json, text/event-stream'
                'Mcp-Session-Id' = $sessionId
                'Mcp-Protocol-Version' = $ProtocolVersion
            } -TimeoutSec 10 -UseBasicParsing | Out-Null
        }
        catch { }
    }
}
