# Synthetic ACLs only. Never read/write production ACLs or live runtime data.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$workspace=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $workspace 'codex_bridge\scripts\installed-runtime-migration.ps1')
$verifier=Import-Module (Join-Path $workspace 'mcp_control_center\src\McpControlCenter.InstalledRelease.psm1') -PassThru
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid);$acl.SetGroup($sid);$acl.SetAccessRuleProtection($true,$false)
foreach($rid in @(1531,1197,1981,1003,1679,1811,1367,1453,1277,1091,1733,1601,1877)){
    $fake=New-Object Security.Principal.SecurityIdentifier('S-1-5-21-100-200-300-'+$rid)
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($fake,'Modify','ContainerInherit,ObjectInherit','None','Allow')))
}
$denied=New-Object Security.Principal.SecurityIdentifier('S-1-5-21-100-200-300-5000')
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($denied,'Read','None','None','Deny')))
$next=Get-MigrationAncestorAcl $acl $sid.Value
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('ancestor-acl-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture|Out-Null
Set-Acl -LiteralPath $fixture -AclObject $next
$actual=Get-Acl -LiteralPath $fixture
function AclView([string]$sddl){
    # Model an observed canonical DACL without .NET sorting it again while the
    # fixture is constructed. The live incident contained this Allow-only reorder.
    $view=[pscustomobject]@{Sddl=$sddl;AreAccessRulesProtected=$true;AreAccessRulesCanonical=$true}
    $view|Add-Member ScriptMethod GetSecurityDescriptorSddlForm {param($sections) $this.Sddl}
    return $view
}
$raw=New-Object Security.AccessControl.RawSecurityDescriptor($next.Sddl)
$reordered=New-Object Security.AccessControl.RawAcl($raw.DiscretionaryAcl.Revision,$raw.DiscretionaryAcl.Count)
foreach($ace in $raw.DiscretionaryAcl){if($ace.AceQualifier -eq 'AccessDenied'){$reordered.InsertAce($reordered.Count,$ace)}}
$allows=@($raw.DiscretionaryAcl|Where-Object AceQualifier -eq AccessAllowed);[Array]::Reverse($allows)
foreach($ace in $allows){$reordered.InsertAce($reordered.Count,$ace)}
$raw.DiscretionaryAcl=$reordered;$observedOrder=AclView ($raw.GetSddlForm('All'))
$strict=& $verifier {param($a,$b) Test-McpCcInstalledAclWrite $a $b} $observedOrder $next
if(-not (Get-Command Test-MigrationAncestorAclWrite -ErrorAction SilentlyContinue)){
    if($strict){throw 'EXPECTED_ALLOW_ORDER_BASELINE_NOT_REPRODUCED'}
    [pscustomobject]@{phase='BASELINE_REPRODUCED';strictComparatorAccepted=$strict;fixture=$fixture;runtimeTouched=$false}|ConvertTo-Json
    exit 0
}
$checks=0
function Check([bool]$ok,[string]$why){if(-not $ok){throw $why};$script:checks++}
Check (Test-MigrationAncestorAclWrite $actual $next) 'NTFS Allow-only ordering preserves the exact ACL grant'
Check (Test-MigrationAncestorAclWrite $observedOrder $next) 'Observed Allow-only reorder is accepted'
$again=Get-MigrationAncestorAcl $actual $sid.Value
Check (Test-MigrationAncestorAclWrite $actual $again) 'Ancestor transform is idempotent'
function Clone($a){$copy=New-Object Security.AccessControl.DirectorySecurity;$copy.SetSecurityDescriptorSddlForm($a.Sddl);return $copy}
$bad=Clone $actual
$bad.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($denied,'FullControl','None','None','Allow')))
Check (-not(Test-MigrationAncestorAclWrite $bad $next)) 'Added foreign allow is rejected'
$bad=Clone $actual
$bad.RemoveAccessRuleAll((New-Object Security.AccessControl.FileSystemAccessRule($denied,'Read','None','None','Deny')))
Check (-not(Test-MigrationAncestorAclWrite $bad $next)) 'Dropped Deny is rejected'
$bad=Clone $actual;$bad.SetAccessRuleProtection($false,$true)
Check (-not(Test-MigrationAncestorAclWrite $bad $next)) 'Unprotected DACL is rejected'
$bad=Clone $actual;$bad.SetOwner($denied)
Check (-not(Test-MigrationAncestorAclWrite $bad $next)) 'Changed Owner is rejected'
# Reordering Deny entries remains rejected even in an otherwise canonical ACL.
$raw=New-Object Security.AccessControl.RawSecurityDescriptor($actual.Sddl)
$denyAce=New-Object Security.AccessControl.CommonAce(0,[Security.AccessControl.AceQualifier]::AccessDenied,2,$denied,$false,$null)
$raw.DiscretionaryAcl.InsertAce(0,$denyAce)
$one=AclView ($raw.GetSddlForm('All'))
$first=$raw.DiscretionaryAcl[0];$raw.DiscretionaryAcl.RemoveAce(0);$raw.DiscretionaryAcl.InsertAce(1,$first)
$two=AclView ($raw.GetSddlForm('All'))
Check (-not(Test-MigrationAncestorAclWrite $one $two)) 'Deny order is not normalized'
[pscustomobject]@{ok=$true;checks=$checks;fixture=$fixture;runtimeTouched=$false;strictComparatorAccepted=$strict}|ConvertTo-Json
