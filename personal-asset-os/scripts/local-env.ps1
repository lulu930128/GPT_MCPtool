Set-StrictMode -Version 3.0

function Get-LocalEnvValue {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $path = Join-Path $ProjectRoot ".env"
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    foreach ($line in Get-Content -LiteralPath $path -Encoding UTF8) {
        if ($line -match ("^\s*" + [Regex]::Escape($Name) + "\s*=\s*(.*)$")) {
            $value = $matches[1].Trim()
            if (
                $value.Length -ge 2 -and
                (($value.StartsWith('"') -and $value.EndsWith('"')) -or
                 ($value.StartsWith("'") -and $value.EndsWith("'")))
            ) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            return $value
        }
    }
    return $null
}

function Set-ControlPlaneApiKeyFromLocalEnv {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)

    $value = Get-LocalEnvValue -ProjectRoot $ProjectRoot -Name "OPENAI_API_KEY"
    if ([string]::IsNullOrWhiteSpace($value)) {
        $value = $env:CONTROL_PLANE_API_KEY
    }
    if ([string]::IsNullOrWhiteSpace($value)) {
        $value = $env:OPENAI_API_KEY
    }
    if ([string]::IsNullOrWhiteSpace($value)) { return $false }
    $env:CONTROL_PLANE_API_KEY = $value
    return $true
}

function Set-ControlPlaneOrganizationIdFromLocalEnv {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)

    $value = Get-LocalEnvValue -ProjectRoot $ProjectRoot -Name "CONTROL_PLANE_ORGANIZATION_ID"
    if ([string]::IsNullOrWhiteSpace($value)) {
        $value = $env:CONTROL_PLANE_ORGANIZATION_ID
    }
    if ([string]::IsNullOrWhiteSpace($value)) { return $false }
    $env:CONTROL_PLANE_ORGANIZATION_ID = $value
    return $true
}
