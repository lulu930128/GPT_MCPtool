Set-StrictMode -Version 2.0

function Get-ControlPlaneSecretPath {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [string]$SecretPath
  )

  if (-not [string]::IsNullOrWhiteSpace($SecretPath)) {
    return $SecretPath
  }

  return (Join-Path $ProjectRoot ".secrets\control-plane-api-key.dpapi")
}

function Save-ControlPlaneApiKeySecret {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][securestring]$Secret,
    [string]$SecretPath
  )

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
    }
  }

  try {
    $encrypted = (Get-Content -LiteralPath $path -Raw).Trim()
    $secure = ConvertTo-SecureString $encrypted
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
      $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
      $usable = -not [string]::IsNullOrWhiteSpace($value)
    }
    finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }

    return [pscustomobject]@{
      path = $path
      exists = $true
      decryptable = $true
      usable = $usable
    }
  }
  catch {
    return [pscustomobject]@{
      path = $path
      exists = $true
      decryptable = $false
      usable = $false
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
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    if ([string]::IsNullOrWhiteSpace($value)) {
      return $false
    }
    $env:CONTROL_PLANE_API_KEY = $value
    return $true
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}
