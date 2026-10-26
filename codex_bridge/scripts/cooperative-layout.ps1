# Code-only layout resolution for the existing cooperative transport.
# The daily Bridge carries native dependencies, but never another CC owner.
function Assert-CbCooperativeCodePath([string]$Path) {
  $cursor=[IO.Path]::GetFullPath($Path)
  while($cursor){
    if(Test-Path -LiteralPath $cursor){
      if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'COOPERATIVE_REPARSE_REJECTED'}
    }
    $cursor=Split-Path -Parent $cursor
  }
}
function Read-CbCooperativeCodeJson([string]$Path) {
  Assert-CbCooperativeCodePath $Path
  $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if($item.PSIsContainer -or $item.Length -gt 131072){throw 'COOPERATIVE_METADATA_INVALID'}
  return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}
function Get-CbCooperativeDailyLayout([string]$ProjectRoot) {
  $project=[IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
  $release=Split-Path -Parent $project
  $versions=Split-Path -Parent $release
  $runtime=if($versions){Split-Path -Parent $versions}else{''}
  $source=if($runtime){Split-Path -Parent $runtime}else{''}
  $marker=Join-Path $release 'daily-mode.json'
  $nested=$versions -and $runtime -and (Split-Path -Leaf $versions) -ieq 'versions' -and (Split-Path -Leaf $runtime) -ieq 'Runtime'
  if(-not $nested -and -not(Test-Path -LiteralPath $marker)){return $null}
  if(-not $nested -or (Split-Path -Leaf $project) -ine 'codex_bridge' -or
    (Split-Path -Leaf $source) -ine 'codex_bridge' -or (Split-Path -Leaf $release) -cnotmatch '^[a-z0-9][a-z0-9_-]{0,47}$'){throw 'COOPERATIVE_LAYOUT_INVALID'}
  $mode=Read-CbCooperativeCodeJson $marker
  if($mode.contract -cne 'mcpcc-daily-user-v1' -or $mode.trayOwner -cne 'independent-cc'){throw 'COOPERATIVE_LAYOUT_INVALID'}
  return [pscustomobject]@{projectRoot=$project;workspaceRoot=(Split-Path -Parent $source)}
}
function Get-CbCooperativeNativeRoot([string]$ProjectRoot) {
  $daily=Get-CbCooperativeDailyLayout $ProjectRoot
  if($null -ne $daily){return Join-Path $daily.projectRoot 'scripts\shared-native'}
  return [IO.Path]::GetFullPath((Join-Path $ProjectRoot '..\mcp_control_center\src'))
}
function Get-CbCooperativeControllerWrapper([string]$ProjectRoot) {
  $daily=Get-CbCooperativeDailyLayout $ProjectRoot
  if($null -eq $daily){return [IO.Path]::GetFullPath((Join-Path $ProjectRoot '..\mcp_control_center\scripts\invoke-component-controller.ps1'))}
  # Resolve only the independent CC's canonical selector; no source/legacy fallback.
  $runtime=Join-Path $daily.workspaceRoot 'mcp_control_center\Runtime'
  $selectorPath=Join-Path $runtime 'current.json'
  $selector=Read-CbCooperativeCodeJson $selectorPath
  if($selector.contract -cne 'mcpcc-current-v1' -or $selector.version -cnotmatch '^[a-z0-9][a-z0-9_-]{0,47}$'){throw 'COOPERATIVE_CC_SELECTOR_INVALID'}
  $root=Join-Path $runtime ('versions\'+$selector.version)
  $mode=Read-CbCooperativeCodeJson (Join-Path $root 'cc-runtime.json')
  $inventory=Read-CbCooperativeCodeJson (Join-Path $root 'code-inventory.json')
  if($mode.contract -cne 'mcpcc-runtime-v1' -or $mode.version -cne $selector.version -or
    $inventory.contract -cne 'mcpcc-code-inventory-v1' -or $inventory.version -cne $selector.version){throw 'COOPERATIVE_CC_INVENTORY_INVALID'}
  $relative='scripts/invoke-component-controller.ps1'
  $rows=@($inventory.files | Where-Object {$_.path -ceq $relative})
  $wrapper=Join-Path $root $relative
  Assert-CbCooperativeCodePath $wrapper
  if($rows.Count -ne 1 -or $rows[0].sha256 -notmatch '^[0-9a-fA-F]{64}$' -or
    (Get-FileHash -LiteralPath $wrapper -Algorithm SHA256).Hash -ine $rows[0].sha256){throw 'COOPERATIVE_CC_WRAPPER_CHANGED'}
  $again=Read-CbCooperativeCodeJson $selectorPath
  if($again.contract -cne $selector.contract -or $again.version -cne $selector.version){throw 'COOPERATIVE_CC_SELECTION_CHANGED'}
  return $wrapper
}
