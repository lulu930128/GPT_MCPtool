param([Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$ProcessId)
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$process=$null
try {
  $runtime=Import-Module (Join-Path $PSScriptRoot 'codex-bridge-runtime.psm1') -PassThru -ErrorAction Stop
  & $runtime {Initialize-CbCooperativeNative -IdentityOnly}
  $process=[Diagnostics.Process]::GetProcessById($ProcessId)
  $proof=[McpCcNormalNative]::Inspect($process)
  # Decimal string preserves Windows creation-time precision in JavaScript.
  [pscustomobject]@{pid=$proof.pid;startedUtcTicks=[string]$proof.startedUtcTicks;sid=$proof.sid;image=$proof.image;session=$proof.session} | ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine('PROCESS_IDENTITY_UNVERIFIED')
  exit 1
} finally {if($null-ne$process){$process.Dispose()}}
