Set-StrictMode -Version 2.0

function Get-ControlPlaneSecretPath {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [string]$SecretPath
  )

  if (-not [string]::IsNullOrWhiteSpace($SecretPath)) {
    return [IO.Path]::GetFullPath($SecretPath)
  }

  return (Join-Path $ProjectRoot ".secrets\control-plane-api-key.dpapi")
}

function Test-ControlPlaneApiKeyShape {
  param([Parameter(Mandatory = $true)][securestring]$Secret)

  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secret)
  try {
    $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    return ($value -match '^sk-[A-Za-z0-9_-]{20,}$')
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

function Save-ControlPlaneApiKeySecret {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][securestring]$Secret,
    [string]$SecretPath
  )

  if (-not (Test-ControlPlaneApiKeyShape -Secret $Secret)) {
    throw "The runtime key format is invalid. Expected a non-empty sk-... key."
  }

  $path = Get-ControlPlaneSecretPath -ProjectRoot $ProjectRoot -SecretPath $SecretPath
  $dir = Split-Path -Parent $path
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  ConvertFrom-SecureString $Secret | Set-Content -LiteralPath $path -Encoding ascii
  return $path
}

function Test-ControlPlaneApiKeySecret {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [string]$SecretPath
  )

  $path = Get-ControlPlaneSecretPath -ProjectRoot $ProjectRoot -SecretPath $SecretPath
  if (-not (Test-Path -LiteralPath $path)) {
    return [pscustomobject]@{
      path = $path
      exists = $false
      decryptable = $false
      usable = $false
      storage = "Windows DPAPI current-user encrypted"
    }
  }

  try {
    $encrypted = (Get-Content -LiteralPath $path -Raw).Trim()
    $secure = ConvertTo-SecureString $encrypted
    return [pscustomobject]@{
      path = $path
      exists = $true
      decryptable = $true
      usable = Test-ControlPlaneApiKeyShape -Secret $secure
      storage = "Windows DPAPI current-user encrypted"
    }
  }
  catch {
    return [pscustomobject]@{
      path = $path
      exists = $true
      decryptable = $false
      usable = $false
      storage = "Windows DPAPI current-user encrypted"
    }
  }
}

function Set-ControlPlaneApiKeyEnvFromSecret {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [string]$SecretPath
  )

  if (-not [string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)) {
    return $true
  }

  $path = Get-ControlPlaneSecretPath -ProjectRoot $ProjectRoot -SecretPath $SecretPath
  if (-not (Test-Path -LiteralPath $path)) {
    return $false
  }

  $encrypted = (Get-Content -LiteralPath $path -Raw).Trim()
  $secure = ConvertTo-SecureString $encrypted
  if (-not (Test-ControlPlaneApiKeyShape -Secret $secure)) {
    return $false
  }

  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    return $true
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}
