Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$PythonPath = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
$FingerprintScript = Join-Path $PSScriptRoot 'smoke-kgi-overlay.py'

function Get-DatabaseFingerprint {
    $json = & $PythonPath -X utf8 $FingerprintScript --database-fingerprint
    if ($LASTEXITCODE -ne 0) { throw 'Database fingerprint failed.' }
    return ($json | ConvertFrom-Json)
}

$before = Get-DatabaseFingerprint
$dashboard = Invoke-RestMethod -Uri 'http://127.0.0.1:18876/api/dashboard' -TimeoutSec 60
$portfolio = @(Invoke-RestMethod -Uri 'http://127.0.0.1:18876/api/portfolio' -TimeoutSec 60)
$after = Get-DatabaseFingerprint

$brokerPositions = @($portfolio | Where-Object { [string]$_.position_source -eq 'kgi_broker' })
[decimal]$projectedTotal = 0
foreach ($position in $brokerPositions) {
    if ($position.valuation_included -eq $true -and $null -ne $position.market_value) {
        $projectedTotal += [decimal]$position.market_value
    }
}
[decimal]$brokerTotal = $dashboard.metrics.broker_market_value
[decimal]$investmentTotal = $dashboard.metrics.investment_market_value
$allIncluded = $brokerPositions.Count -gt 0
$allOpaque = $brokerPositions.Count -gt 0
foreach ($position in $brokerPositions) {
    if ($position.valuation_included -ne $true) { $allIncluded = $false }
    if (-not ([string]$position.investment_account_id).StartsWith('kgi_')) { $allOpaque = $false }
}

$checks = [ordered]@{
    broker_read_usable = @('complete', 'partial') -contains [string]$dashboard.broker.status
    broker_schema_v2 = [string]$dashboard.broker.schema_version -eq 'paos.broker_valuation.v2'
    market_statuses_present = @($dashboard.broker.markets).Count -gt 0
    source_time_present = -not [string]::IsNullOrWhiteSpace([string]$dashboard.broker.source_as_of)
    broker_positions_applied = $brokerPositions.Count -eq [int]$dashboard.broker.position_count
    broker_total_matches_rows = $brokerTotal -eq $projectedTotal
    investment_total_includes_broker = $investmentTotal -ge $brokerTotal
    all_broker_rows_included = $allIncluded
    all_accounts_opaque = $allOpaque
    database_table_counts_unchanged = [string]$before.table_counts_hash -eq [string]$after.table_counts_hash
    database_file_unchanged = [string]$before.database_file_hash -eq [string]$after.database_file_hash
}
$ok = -not ($checks.Values -contains $false)
[pscustomobject]@{
    ok = $ok
    broker_status = [string]$dashboard.broker.status
    dashboard_read_mode = [string]$dashboard.broker.read_mode
    position_count = $brokerPositions.Count
    checks = $checks
} | ConvertTo-Json -Depth 5

if (-not $ok) { exit 1 }
