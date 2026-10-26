<#
日常更新（先讀 docs/DailyCodeUpdate.md）：
  .\daily-code-update.ps1 -Action Stage -CandidateRoot C:\GPT_MCPtool -Version fix-20261025
  .\daily-code-update.ps1 -Action Update -Version fix-20261025 -CodeOnly
首次採用由 cutover-daily-code.ps1 一次完成既有 owner 停機、選版與 Startup。
此日常入口不提權、不修改 ACL、不遷移資料。
#>
[CmdletBinding()]
param(
    [ValidateSet('Stage','Adopt','Update','Start','Status','RecoverAfterReboot')][string]$Action='Status',
    [string]$CandidateRoot,
    [ValidatePattern('^[a-z0-9][a-z0-9_-]{0,47}$')][string]$Version,
    [switch]$CodeOnly,
    [switch]$LegacyRetired,
    [ValidatePattern('^cutover-[0-9a-f]{32}$')][string]$OperationName,
    [switch]$ResumeUnchangedLock
)
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
Import-Module 'C:\GPT_MCPtool\mcp_control_center\src\McpControlCenter.DailyCode.psm1' -Force
$root='C:\GPT_MCPtool\codex_bridge\Runtime'
switch($Action) {
    RecoverAfterReboot { Repair-McpDailyAfterReboot -Root $root -Version $Version -OperationName $OperationName -ResumeUnchangedLock:$ResumeUnchangedLock | ConvertTo-Json }
    Stage { New-McpDailyCandidate -Root $root -Source $CandidateRoot -Version $Version | ConvertTo-Json }
    Adopt { Initialize-McpDailySelector -Root $root -Version $Version -LegacyRetired:$LegacyRetired | ConvertTo-Json }
    Update {
        if(-not $CodeOnly){throw 'DAILY_CODE_ONLY_REVIEW_REQUIRED'}
        if($CandidateRoot){New-McpDailyCandidate -Root $root -Source $CandidateRoot -Version $Version | ConvertTo-Json}
        Invoke-McpDailyUpdate -Root $root -Version $Version -CodeOnly | ConvertTo-Json
    }
    Start { Start-McpDailyCurrent -Root $root | ConvertTo-Json }
    Status { Get-McpDailyStatus -Root $root | ConvertTo-Json -Depth 5 }
}
