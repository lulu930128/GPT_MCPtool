Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$module = Import-Module (Join-Path $root 'scripts\japanese-study-runtime.psm1') -Force -PassThru
$identity = (& node (Join-Path $root 'scripts\build-identity.mjs') (Join-Path $root 'dist')) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Node build identity failed' }
$context = New-JapaneseStudyRuntimeContext -ProjectRoot $root -HubRoot $root -NodePath (Get-Command node).Source -UvPath (Get-Command node).Source
$actual = & $module { param($ctx) Get-JsExpectedBuildId -Context $ctx } $context
if ($actual -ne $identity.buildId) { throw "Build identity mismatch: $actual / $($identity.buildId)" }
$temporary = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('jstudy-ui-build-' + [Guid]::NewGuid().ToString('N'))))
try {
  New-Item -ItemType Directory -Path (Join-Path $temporary 'src\ui') -Force | Out-Null
  $style = Join-Path $temporary 'src\ui\review.css'
  $entry = Join-Path $temporary 'server.js'
  [IO.File]::WriteAllText($style, '/* test */')
  [IO.File]::WriteAllText($entry, '// test')
  (Get-Item -LiteralPath $style).LastWriteTimeUtc = [DateTime]::UtcNow.AddMinutes(-10)
  (Get-Item -LiteralPath $entry).LastWriteTimeUtc = [DateTime]::UtcNow.AddMinutes(-5)
  $fixture = @{ projectRoot = $temporary; mcpEntry = $entry; expectedBuildId = '' }
  if (-not (& $module { param($ctx) Test-JsBuildCurrent -Context $ctx } $fixture)) { throw 'Fresh UI build rejected' }
  (Get-Item -LiteralPath $style).LastWriteTimeUtc = [DateTime]::UtcNow
  if (& $module { param($ctx) Test-JsBuildCurrent -Context $ctx } $fixture) { throw 'Edited CSS did not invalidate build freshness' }
  [pscustomobject]@{ ok = $true; buildId = $actual; assertions = 3 } | ConvertTo-Json
}
finally {
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if (-not $temporary.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($temporary) -notlike 'jstudy-ui-build-*') { throw 'Unsafe test cleanup path' }
  Remove-Item -LiteralPath $temporary -Recurse -Force
}
