param(
  [string]$ProjectRoot,
  [string]$Version = "latest",
  [switch]$Force
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

$headers = @{
  Accept = "application/vnd.github+json"
  "User-Agent" = "English-Study-Tunnel-Installer"
}
$releaseUrl = if ($Version -eq "latest") {
  "https://api.github.com/repos/openai/tunnel-client/releases/latest"
}
else {
  $tag = if ($Version.StartsWith("v")) { $Version } else { "v$Version" }
  "https://api.github.com/repos/openai/tunnel-client/releases/tags/$tag"
}

$release = Invoke-RestMethod -Headers $headers -Uri $releaseUrl
$architecture = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }
$assetPattern = "^tunnel-client-$([regex]::Escape($release.tag_name))-windows-$architecture\.zip$"
$asset = @($release.assets | Where-Object { $_.name -match $assetPattern })
$checksumAsset = @($release.assets | Where-Object { $_.name -eq "SHA256SUMS.txt" })
if ($asset.Count -ne 1 -or $checksumAsset.Count -ne 1) {
  throw "Could not resolve a unique Windows tunnel-client asset and SHA256SUMS.txt."
}

$destinationDir = Join-Path $ProjectRoot "vendor\tunnel-client"
$destination = Join-Path $destinationDir "tunnel-client.exe"
if ((Test-Path -LiteralPath $destination) -and -not $Force) {
  $installedVersion = (& $destination --version | Out-String).Trim()
  if ($installedVersion -match [regex]::Escape($release.tag_name.TrimStart("v"))) {
    [pscustomobject]@{ installed = $true; changed = $false; path = $destination; version = $installedVersion; reason = "requested version already installed" } | ConvertTo-Json -Depth 4
    exit 0
  }
  throw "A different tunnel-client already exists. Re-run with -Force only after reviewing the requested release."
}

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempDir = Join-Path $tempRoot ("estudy-tunnel-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempDir | Out-Null
try {
  $archivePath = Join-Path $tempDir $asset[0].name
  $checksumsPath = Join-Path $tempDir "SHA256SUMS.txt"
  Invoke-WebRequest -UseBasicParsing -Uri $asset[0].browser_download_url -OutFile $archivePath
  Invoke-WebRequest -UseBasicParsing -Uri $checksumAsset[0].browser_download_url -OutFile $checksumsPath

  $checksumLine = Get-Content -LiteralPath $checksumsPath | Where-Object { $_ -match ([regex]::Escape($asset[0].name) + "$") } | Select-Object -First 1
  if (-not $checksumLine) { throw "The release checksum file does not contain the selected Windows asset." }
  $expectedHash = ($checksumLine -split "\s+")[0].ToUpperInvariant()
  $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash
  if ($actualHash -ne $expectedHash) { throw "The downloaded tunnel-client archive failed SHA-256 verification." }

  $extractDir = Join-Path $tempDir "extract"
  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDir
  $executables = @(Get-ChildItem -LiteralPath $extractDir -Recurse -Filter "tunnel-client.exe")
  if ($executables.Count -ne 1) { throw "Expected one tunnel-client.exe, found $($executables.Count)." }

  New-Item -ItemType Directory -Force -Path $destinationDir | Out-Null
  Copy-Item -LiteralPath $executables[0].FullName -Destination $destination -Force:$Force
  $installedVersion = (& $destination --version | Out-String).Trim()
  [pscustomobject]@{
    installed = $true; changed = $true; path = $destination; version = $installedVersion
    archiveSha256 = $actualHash; executableSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash
  } | ConvertTo-Json -Depth 4
}
finally {
  $resolvedTemp = [IO.Path]::GetFullPath($tempDir)
  if ($resolvedTemp.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedTemp)) {
    Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
  }
}
