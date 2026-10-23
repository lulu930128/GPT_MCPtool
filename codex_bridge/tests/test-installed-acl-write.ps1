Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$principal=[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'USE_NON_ADMIN_WINDOW_STOP'}
$workspace=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$base=Join-Path $workspace 'codex_bridge\.tmp'
$fixture=Join-Path $base ('acl-write-'+[guid]::NewGuid().ToString('N'))
$verifier=$null;$checks=0;$completed=$false;$writes=0
function Check([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message};$script:checks++}
function Descriptor([string]$Sddl){$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetSecurityDescriptorSddlForm($Sddl);return $acl}
function Matches($Actual,$Expected){return & $verifier {param($a,$b)Test-McpCcInstalledAclWrite $a $b} $Actual $Expected}
try {
    $verifier=Import-Module (Join-Path $workspace 'mcp_control_center\src\McpControlCenter.InstalledRelease.psm1') -Force -PassThru
    $sid='S-1-5-21-100-200-300-1001'
    $baseSddl="O:${sid}G:SYD:P(D;OICI;FR;;;BU)(A;OICI;FA;;;$sid)"
    $expected=Descriptor $baseSddl
    Check (Matches (Descriptor $baseSddl) $expected) 'Identical protected ACL must verify'
    Check (Matches (Descriptor ($baseSddl.Replace('D:P','D:PAI'))) $expected) 'Only AUTO_INHERITED metadata may differ'
    $cases=@(
        @{name='lost Deny';sddl=$baseSddl.Replace('(D;OICI;FR;;;BU)','')},
        @{name='changed Deny SID';sddl=$baseSddl.Replace(';;;BU)',';;;AU)')},
        @{name='changed Deny rights';sddl=$baseSddl.Replace(';FR;',';FW;')},
        @{name='lost child scope';sddl=$baseSddl.Replace('(D;OICI;','(D;;')},
        @{name='lost self scope';sddl=$baseSddl.Replace('(D;OICI;','(D;OICIIO;')},
        @{name='lost deep scope';sddl=$baseSddl.Replace('(D;OICI;','(D;OICINP;')},
        @{name='extra Allow';sddl=$baseSddl+'(A;;FA;;;AU)'},
        @{name='changed owner';sddl=$baseSddl.Replace("O:${sid}G:",'O:BAG:')},
        @{name='changed group';sddl=$baseSddl.Replace('G:SY','G:BA')},
        @{name='unprotected';sddl=$baseSddl.Replace('D:P','D:AI')},
        @{name='null DACL';sddl="O:${sid}G:SYD:NO_ACCESS_CONTROL"},
        @{name='Deny changed to Allow';sddl=$baseSddl.Replace('(D;','(A;')},
        @{name='inherited ACE';sddl=$baseSddl.Replace('(D;OICI;','(D;OICIID;')}
    )
    foreach($case in $cases){Check (-not(Matches (Descriptor $case.sddl) $expected)) ('Write verification must reject '+$case.name)}

    # DirectorySecurity removes AUTO_INHERIT_REQ while loading SDDL. Preserve
    # this negative input as raw SDDL so it actually reaches the verifier.
    $requestRaw=New-Object Security.AccessControl.RawSecurityDescriptor($baseSddl.Replace('D:P','D:PAR'))
    if(-not([int]$requestRaw.ControlFlags -band [int][Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInheritRequired)){throw 'AUTO_INHERIT_REQUEST_FIXTURE_INVALID'}
    $requestDescriptor=[pscustomobject]@{
        AreAccessRulesProtected=$expected.AreAccessRulesProtected
        AreAccessRulesCanonical=$expected.AreAccessRulesCanonical
        RawSddl=$requestRaw.GetSddlForm([Security.AccessControl.AccessControlSections]::All)
    }
    $requestDescriptor | Add-Member -MemberType ScriptMethod -Name GetSecurityDescriptorSddlForm -Value {param($sections) return $this.RawSddl}
    Check (-not(Matches $requestDescriptor $expected)) 'Write verification must reject auto-inherit request'

    # Actual NTFS roundtrip, only on two newly created disposable fixture objects.
    # The original workspace/ancestors and all production paths remain untouched.
    [void][IO.Directory]::CreateDirectory($fixture)
    $file=Join-Path $fixture 'sample.txt'
    [IO.File]::WriteAllText($file,'ACL_ROUNDTRIP_FIXTURE',(New-Object Text.UTF8Encoding($false)))
    $realSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $observations=New-Object 'Collections.Generic.List[object]'
    # File first so the directory write cannot alter the child's input ACL.
    foreach($path in @($file,$fixture)){
        $before=Get-Acl -LiteralPath $path
        $directory=[IO.Directory]::Exists($path)
        $wanted=& $verifier {param($a,$s,$d)Get-McpCcInstalledPrivateAcl $a $s $d} $before $realSid $directory
        $sections=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
        $before.SetSecurityDescriptorSddlForm($wanted.GetSecurityDescriptorSddlForm($sections),[Security.AccessControl.AccessControlSections]::Access)
        Set-Acl -LiteralPath $path -AclObject $before -ErrorAction Stop;$writes++
        $observed=Get-Acl -LiteralPath $path
        Check (Matches $observed $wanted) 'Actual NTFS readback must match every permission and owner/group'
        Check $observed.AreAccessRulesProtected 'Actual NTFS DACL must remain protected'
        $raw=New-Object Security.AccessControl.RawSecurityDescriptor($observed.GetSecurityDescriptorSddlForm($sections))
        $observations.Add([pscustomobject]@{kind=$(if($directory){'directory'}else{'file'});autoInherited=[bool]([int]$raw.ControlFlags -band [int][Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited)})
    }
    Check ([IO.File]::ReadAllText($file) -ceq 'ACL_ROUNDTRIP_FIXTURE') 'ACL write must preserve file bytes'
    $report=[pscustomobject]@{ok=$true;checks=$checks;writeback='ACTUAL_NTFS_FILE_AND_DIRECTORY';fixtureAclWrites=$writes;observations=$observations.ToArray();productionTouched=$false}|ConvertTo-Json -Depth 4
    $completed=$true
    $report
} finally {
    if($verifier){Remove-Module $verifier -ErrorAction SilentlyContinue}
    $resolved=[IO.Path]::GetFullPath($fixture)
    if(-not $resolved.StartsWith($base+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'FIXTURE_CLEANUP_SCOPE_REJECTED'}
    if($completed -and (Test-Path -LiteralPath $resolved)){Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop}
    elseif(Test-Path -LiteralPath $resolved){Write-Output ('FAILED_FIXTURE_RETAINED: '+$resolved)}
}
