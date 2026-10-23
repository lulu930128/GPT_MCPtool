# Real NTFS, normal-token regression. Writes only a new disposable TEMP tree.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=New-Object Security.Principal.WindowsPrincipal($identity)
if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'NON_ADMIN_FIXTURE_REQUIRED'}
$workspace=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $workspace 'codex_bridge\scripts\installed-runtime-migration.ps1')
$verifier=Import-Module (Join-Path $workspace 'mcp_control_center\src\McpControlCenter.InstalledRelease.psm1') -PassThru
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('migration-dacl-write-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture|Out-Null
$checks=0
function Check([bool]$ok,[string]$why){if(-not $ok){throw $why};$script:checks++}
$acl=Get-MigrationAncestorAcl (Get-Acl -LiteralPath $fixture) $identity.User.Value
Set-MigrationDacl $fixture $acl
Check (Test-MigrationAncestorAclWrite (Get-Acl -LiteralPath $fixture) $acl) 'Initial directory DACL'
$again=Get-MigrationAncestorAcl (Get-Acl -LiteralPath $fixture) $identity.User.Value
Set-MigrationDacl $fixture $again
Check (Test-MigrationAncestorAclWrite (Get-Acl -LiteralPath $fixture) $again) 'Already protected directory DACL'
$file=Join-Path $fixture 'fixture.txt'
[IO.File]::WriteAllText($file,'unchanged fixture')
$hash=(Get-FileHash -LiteralPath $file).Hash
$before=Get-Acl -LiteralPath $file
$next=& $verifier {param($a,$s) Get-McpCcInstalledPrivateAcl $a $s $false} $before $identity.User.Value
Set-MigrationDacl $file $next
Set-MigrationDacl $file $next
Check (& $verifier {param($a,$b) Test-McpCcInstalledAclWrite $a $b} (Get-Acl -LiteralPath $file) $next) 'Protected file DACL survives repeat'
Check ((Get-FileHash -LiteralPath $file).Hash -ceq $hash) 'File bytes retained'
$bad=Get-Acl -LiteralPath $file
$bad.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-21-100-200-300-5000')))
$failure='';try{Set-MigrationDacl $file $bad}catch{$failure=$_.Exception.Message}
Check ($failure -ceq 'MIGRATION_ACL_IDENTITY_CHANGE_REJECTED') 'Owner change rejected before persistence'
Check ((Get-FileHash -LiteralPath $file).Hash -ceq $hash) 'Rejected change retains file bytes'
[pscustomobject]@{ok=$true;checks=$checks;fixture=$fixture;productionTouched=$false;isAdmin=$false}|ConvertTo-Json
