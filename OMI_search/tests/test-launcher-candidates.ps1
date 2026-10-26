Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

# Extract only the parser; all filesystem reads below use synthetic evidence.
$modulePath = Join-Path $PSScriptRoot '..\scripts\omi-search-runtime.psm1'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($modulePath, [ref]$tokens, [ref]$parseErrors)
if (@($parseErrors).Count -ne 0) { throw 'Runtime module has parse errors.' }
$functionAst = $ast.Find({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Get-OmiLauncherBackendCandidates'
}, $false)
if ($null -eq $functionAst) { throw 'Launcher candidate parser missing.' }
. ([scriptblock]::Create($functionAst.Extent.Text))

$script:LauncherExists = $true
$script:Fixtures = @()
$script:Assertions = 0
function Test-Path { param($LiteralPath, $PathType) return $script:LauncherExists }
function Get-ChildItem {
    param($LiteralPath, [switch]$Recurse, [switch]$File, $Filter, $ErrorAction)
    return $script:Fixtures
}
function Get-Content {
    param($LiteralPath, $Encoding, $Tail, $ErrorAction)
    $fixture = $script:Fixtures | Where-Object { $_.FullName -eq $LiteralPath }
    if ($fixture.Unreadable) { throw 'Synthetic read failure.' }
    return $fixture.Lines
}
function Assert-Candidates {
    param([string[]]$Expected)
    $actual = @(Get-OmiLauncherBackendCandidates)
    if (($actual -join '|') -cne ($Expected -join '|')) { throw 'Unexpected launcher candidates.' }
    $script:Assertions += 1
}
function New-Fixture {
    param([string]$Name, [string[]]$Lines, [int]$Order = 0, [bool]$Unreadable = $false)
    return [pscustomobject]@{ FullName = $Name; Lines = $Lines; LastWriteTime = $Order; Unreadable = $Unreadable }
}

$script:LauncherExists = $false
Assert-Candidates @()
$script:LauncherExists = $true
Assert-Candidates @()
$script:Fixtures = @(New-Fixture 'empty' @())
Assert-Candidates @()
$script:Fixtures = @(New-Fixture 'one-line' @('Launcher starting.'))
Assert-Candidates @()
$script:Fixtures = @(New-Fixture 'one-line' @('selected=http://127.0.0.1:8400'))
Assert-Candidates @('http://127.0.0.1:8400')
$script:Fixtures = @(New-Fixture 'multiple-lines' @(
    'selected=http://127.0.0.1:8400',
    'Starting backend worker on http://127.0.0.1:8560',
    'selected=http://127.0.0.1:8560'
))
Assert-Candidates @('http://127.0.0.1:8560', 'http://127.0.0.1:8400')
$script:Fixtures = @(
    (New-Fixture 'older' @('selected=http://127.0.0.1:8400') 1),
    (New-Fixture 'newer' @('selected=http://127.0.0.1:8560') 2),
    (New-Fixture 'unreadable' @() 3 $true)
)
Assert-Candidates @('http://127.0.0.1:8560', 'http://127.0.0.1:8400')
[pscustomobject]@{ ok = $true; assertions = $script:Assertions; productionIo = $false } | ConvertTo-Json
