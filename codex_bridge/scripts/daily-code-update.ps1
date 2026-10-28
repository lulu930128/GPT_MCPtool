<#
日常更新（先讀 docs/DailyCodeUpdate.md）：
  .\daily-code-update.ps1 -Action Stage -CandidateRoot C:\GPT_MCPtool -Version fix-20261025
  .\daily-code-update.ps1 -Action Update -Version fix-20261025 -CodeOnly
首次採用由 cutover-daily-code.ps1 一次完成既有 owner 停機、選版與 Startup。
此日常入口不提權、不修改 ACL、不遷移資料。
#>
[CmdletBinding()]
param(
    [ValidateSet('Stage','Adopt','Update','Recover','Start','Status','Preflight','RecoverAfterReboot')][string]$Action='Status',
    [string]$CandidateRoot,
    [ValidatePattern('^[a-z0-9][a-z0-9_-]{0,47}$')][string]$Version,
    [switch]$CodeOnly,
    [switch]$LegacyRetired,
    [ValidatePattern('^cutover-[0-9a-f]{32}$')][string]$OperationName,
    [ValidatePattern('^[0-9a-f]{32}$')][string]$OperationId,
    [ValidatePattern('^[0-9a-f]{64}$')][string]$SourceDigest,
    [switch]$ResumeUnchangedLock
)
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
Import-Module 'C:\GPT_MCPtool\mcp_control_center\src\McpControlCenter.DailyCode.psm1' -Force
$root='C:\GPT_MCPtool\codex_bridge\Runtime'
try { switch($Action) {
    RecoverAfterReboot { Repair-McpDailyAfterReboot -Root $root -Version $Version -OperationName $OperationName -ResumeUnchangedLock:$ResumeUnchangedLock | ConvertTo-Json }
    Stage { New-McpDailyCandidate -Root $root -Source $CandidateRoot -Version $Version | ConvertTo-Json }
    Adopt { Initialize-McpDailySelector -Root $root -Version $Version -LegacyRetired:$LegacyRetired | ConvertTo-Json }
    Update {
        if(-not $CodeOnly){throw 'DAILY_CODE_ONLY_REVIEW_REQUIRED'}
        $result=Invoke-McpDailyUpdate -Root $root -Version $Version -CodeOnly -CandidateRoot $CandidateRoot -OperationId $OperationId -SourceDigest $SourceDigest
        $result | ConvertTo-Json -Depth 12
        if($result.phase -notin @('ACCEPTED','ALREADY_SELECTED')){exit 1}
    }
    Recover {
        $result=Repair-McpDailyOperation -Root $root -OperationId $OperationId
        $result | ConvertTo-Json -Depth 12
        if($result.phase -in @('RECOVERY_REQUIRED','DEGRADED')){exit 1}
    }
    Start {
        $result=Start-McpDailyCurrent -Root $root
        $result | ConvertTo-Json -Depth 12
        if($result.phase -cne 'READY'){exit 1}
    }
    Status {
        if($OperationId){Get-McpDailyOperationStatus -Root $root -OperationId $OperationId | ConvertTo-Json -Depth 12}
        else {Get-McpDailyStatus -Root $root | ConvertTo-Json -Depth 5}
    }
    Preflight { Test-McpDailyUpdate -Root $root -Version $Version -CodeOnly:$CodeOnly | ConvertTo-Json -Depth 5 }
} } catch {
    $code=([string]$_.Exception.Message -split ':')[0]
    if($code -cnotmatch '^[A-Z][A-Z0-9_]+$'){$code='DAILY_IO_OR_OWNER_FAILED'}
    @{ok=$false;phase='REJECTED';code=$code;operationId=$OperationId;version=$Version;nextStep=$(if($code -eq 'DAILY_VERSION_CONTENT_CHANGED_USE_NEW_ID'){'PRESERVE_CANDIDATE_USE_NEW_VERSION'}else{'INSPECT_ORIGINAL_OPERATION'})}|ConvertTo-Json -Depth 5
    exit 1
}
