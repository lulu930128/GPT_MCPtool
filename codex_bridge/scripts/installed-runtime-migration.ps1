# Loaded only by the existing independent installed-release operator. No service,
# task, alternate controller, elevation, automatic retry or arbitrary path input.
Set-StrictMode -Version 3.0

function Set-MigrationDacl([string]$Path,$Expected) {
    # Set-Acl copies all sections and its fallback can request Audit on an
    # already-protected DACL. Persist only Access, never SACL/owner/group; the
    # normal token still needs WRITE_DAC. No elevation or failed-write fallback.
    $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'MIGRATION_REPARSE_REJECTED'}
    $sections=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
    $current=$item.GetAccessControl($sections)
    $sid=[Security.Principal.SecurityIdentifier]
    if($current.GetOwner($sid).Value -cne $Expected.GetOwner($sid).Value -or
        $current.GetGroup($sid).Value -cne $Expected.GetGroup($sid).Value){throw 'MIGRATION_ACL_IDENTITY_CHANGE_REJECTED'}
    $current.SetSecurityDescriptorSddlForm($Expected.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access),[Security.AccessControl.AccessControlSections]::Access)
    $item.SetAccessControl($current)
}

function Get-MigrationAncestorAcl($Acl,[string]$OwnerSid) {
    # Preserve descendant access and every Deny; narrow only effective foreign
    # Allows on this directory. Do not recursively reset the source workspace.
    $trusted=@($OwnerSid,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
    if($Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted){throw 'MIGRATION_ANCESTOR_OWNER_REJECTED'}
    $sections=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
    $raw=New-Object Security.AccessControl.RawSecurityDescriptor($Acl.GetSecurityDescriptorSddlForm($sections))
    if($null -eq $raw.DiscretionaryAcl){throw 'PROTECTED_DACL_REQUIRED'}
    $dacl=New-Object Security.AccessControl.RawAcl($raw.DiscretionaryAcl.Revision,($raw.DiscretionaryAcl.Count*2+1))
    $write=[int]([Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership)
    foreach($kind in @('AccessDenied','AccessAllowed')){
        foreach($ace in $raw.DiscretionaryAcl){
            if($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback -or $ace.AceQualifier -notin @('AccessDenied','AccessAllowed')){throw 'UNSUPPORTED_PRIVATE_ACE'}
            if($ace.AceQualifier -ne $kind){continue}
            $flags=[int]$ace.AceFlags -band (-bnot [int][Security.AccessControl.AceFlags]::Inherited)
            $foreign=$kind -eq 'AccessAllowed' -and $ace.SecurityIdentifier.Value -notin $trusted
            $inheritOnly=($flags -band 8) -ne 0
            if(-not $foreign -or $inheritOnly){
                $dacl.InsertAce($dacl.Count,(New-Object Security.AccessControl.CommonAce($flags,$ace.AceQualifier,$ace.AccessMask,$ace.SecurityIdentifier,$false,$null)))
                continue
            }
            if(($ace.AccessMask -band 0xF0000000L) -ne 0){throw 'MIGRATION_EFFECTIVE_GENERIC_ACE_REJECTED'}
            $safe=$ace.AccessMask -band (-bnot $write)
            if($safe){$dacl.InsertAce($dacl.Count,(New-Object Security.AccessControl.CommonAce(0,$ace.AceQualifier,$safe,$ace.SecurityIdentifier,$false,$null)))}
            if($flags -band 3){$dacl.InsertAce($dacl.Count,(New-Object Security.AccessControl.CommonAce(($flags -bor 8),$ace.AceQualifier,$ace.AccessMask,$ace.SecurityIdentifier,$false,$null)))}
        }
    }
    $owner=New-Object Security.Principal.SecurityIdentifier($OwnerSid)
    $full=[int][Security.AccessControl.FileSystemRights]::FullControl
    $hasOwner=@($dacl|Where-Object {$_.AceQualifier -eq 'AccessAllowed' -and $_.SecurityIdentifier.Value -ceq $OwnerSid -and
        -not([int]$_.AceFlags -band [int][Security.AccessControl.AceFlags]::InheritOnly) -and ($_.AccessMask -band $full) -eq $full}).Count -gt 0
    if(-not $hasOwner){$dacl.InsertAce($dacl.Count,(New-Object Security.AccessControl.CommonAce(0,[Security.AccessControl.AceQualifier]::AccessAllowed,$full,$owner,$false,$null)))}
    $raw.DiscretionaryAcl=$dacl
    $raw.SetFlags($raw.ControlFlags -bor [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected)
    $result=New-Object Security.AccessControl.DirectorySecurity
    $result.SetSecurityDescriptorSddlForm($raw.GetSddlForm($sections),$sections)
    return $result
}
function Test-MigrationAncestorAclWrite($Observed,$Expected) {
    # Ancestors retain paired self/child Allows. Windows/.NET may reorder these
    # within the canonical Allow block. Compare their exact binary multiset;
    # preserve Deny order, ACE bytes/count, owner/group and protection. This is
    # deliberately separate from the existing private-state ACL comparator.
    if(-not $Observed.AreAccessRulesProtected -or -not $Expected.AreAccessRulesProtected -or
        -not $Observed.AreAccessRulesCanonical -or -not $Expected.AreAccessRulesCanonical){return $false}
    $sections=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
    $a=New-Object Security.AccessControl.RawSecurityDescriptor($Observed.GetSecurityDescriptorSddlForm($sections))
    $b=New-Object Security.AccessControl.RawSecurityDescriptor($Expected.GetSecurityDescriptorSddlForm($sections))
    if($null -eq $a.DiscretionaryAcl -or $null -eq $b.DiscretionaryAcl -or $null -eq $a.Owner -or $null -eq $b.Owner -or
        $null -eq $a.Group -or $null -eq $b.Group -or $a.Owner.Value -cne $b.Owner.Value -or $a.Group.Value -cne $b.Group.Value){return $false}
    $mask=-bnot [int][Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited
    if(([int]$a.ControlFlags -band $mask) -ne ([int]$b.ControlFlags -band $mask)){return $false}
    $rules=@()
    foreach($raw in @($a,$b)){
        $deny=New-Object 'Collections.Generic.List[string]';$allow=New-Object 'Collections.Generic.List[string]'
        foreach($ace in $raw.DiscretionaryAcl){
            if($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback -or $ace.AceQualifier -notin @('AccessDenied','AccessAllowed')){return $false}
            $bytes=New-Object byte[] $ace.BinaryLength;$ace.GetBinaryForm($bytes,0);$key=[Convert]::ToBase64String($bytes)
            if($ace.AceQualifier -eq 'AccessDenied'){$deny.Add($key)}else{$allow.Add($key)}
        }
        $sorted=$allow.ToArray();[Array]::Sort($sorted,[StringComparer]::Ordinal)
        $rules+=@([pscustomobject]@{deny=($deny.ToArray() -join '|');allow=($sorted -join '|')})
    }
    return $rules[0].deny -ceq $rules[1].deny -and $rules[0].allow -ceq $rules[1].allow
}

function Get-MigrationTree([string]$Root,[string[]]$ExcludeRelative=@()) {
    & $verifier {param($p) Assert-McpCcNoReparseChain $p} $Root
    $rootPath=[IO.Path]::GetFullPath($Root).TrimEnd('\')
    $queue=New-Object 'Collections.Generic.Stack[string]';$queue.Push($rootPath)
    $rows=New-Object 'Collections.Generic.List[object]'
    while($queue.Count){
        $path=$queue.Pop();$item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'MIGRATION_REPARSE_REJECTED'}
        if($rows.Count -ge 10000){throw 'MIGRATION_TREE_LIMIT'}
        $relative=if($path -ceq $rootPath){''}else{$path.Substring($rootPath.Length+1)}
        if($relative -cin $ExcludeRelative){continue}
        $acl=Get-Acl -LiteralPath $path -ErrorAction Stop
        $length=0L;$hash=$null
        if($item.PSIsContainer){foreach($child in Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop){$queue.Push($child.FullName)}}
        else {
            if(@(Get-Item -LiteralPath $path -Stream * -ErrorAction Stop | Where-Object Stream -ne ':$DATA').Count){throw 'MIGRATION_ALTERNATE_STREAM_REQUIRES_REVIEW'}
            $length=$item.Length;$hash=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        $rows.Add([pscustomobject][ordered]@{relative=$relative;directory=[bool]$item.PSIsContainer;length=$length;sha256=$hash;sddl=$acl.Sddl;
            createdUtc=$item.CreationTimeUtc.ToString('o');writtenUtc=$item.LastWriteTimeUtc.ToString('o');attributes=[int]$item.Attributes})
    }
    return @($rows.ToArray() | Sort-Object relative)
}
function Get-MigrationTreeBytes([string]$Root) {
    # Live sizing uses metadata only. Do not bypass the open journal's lock.
    & $verifier {param($p) Assert-McpCcNoReparseChain $p} $Root
    $queue=New-Object 'Collections.Generic.Stack[string]';$queue.Push($Root);$count=0;$bytes=0L
    while($queue.Count){foreach($item in Get-ChildItem -LiteralPath $queue.Pop() -Force -ErrorAction Stop){
        if(++$count -gt 10000){throw 'MIGRATION_TREE_LIMIT'}
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'MIGRATION_REPARSE_REJECTED'}
        if($item.PSIsContainer){$queue.Push($item.FullName)}else{$bytes+=$item.Length}
    }}
    return $bytes
}
function Get-MigrationContentHash($Rows) {
    Get-StatePlanHash @($Rows | Select-Object relative,directory,length,sha256)
}
function Assert-MigrationTree([string]$Root,$Rows) {
    $actual=Get-MigrationTree $Root
    if((Get-MigrationContentHash $actual) -cne (Get-MigrationContentHash $Rows)){throw 'MIGRATION_CONTENT_CHANGED'}
}
function Copy-MigrationTree([string]$Source,[string]$Target,$Rows) {
    if(Test-Path -LiteralPath $Target){throw 'MIGRATION_DESTINATION_EXISTS'}
    Assert-MigrationTree $Source $Rows
    foreach($row in @($Rows | Sort-Object @{e={$_.relative.Length}},relative)){
        $from=if($row.relative){Join-Path $Source $row.relative}else{$Source}
        $to=if($row.relative){Join-Path $Target $row.relative}else{$Target}
        $resolved=[IO.Path]::GetFullPath($to)
        if($resolved -ine $Target -and -not $resolved.StartsWith($Target+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'MIGRATION_PATH_ESCAPE'}
        if($row.directory){New-Item -ItemType Directory -Path $to -ErrorAction Stop | Out-Null}
        else {
            # A stopped writer must remain stopped; refuse an open write handle.
            $input=[IO.File]::Open($from,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
            try{$output=[IO.File]::Open($to,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
                try{$input.CopyTo($output);$output.Flush($true)}finally{$output.Dispose()}
            }finally{$input.Dispose()}
        }
        $oldAcl=Get-Acl -LiteralPath $from;$inherited=Get-Acl -LiteralPath $to
        $next=& $verifier {param($a,$s,$d,$extra) Get-McpCcInstalledPrivateAcl $a $s $d $extra} $oldAcl $operator.sid $row.directory $inherited
        Set-MigrationDacl $to $next
        if(-not(& $verifier {param($a,$b) Test-McpCcInstalledAclWrite $a $b} (Get-Acl -LiteralPath $to) $next)){throw 'MIGRATION_ACL_WRITE_UNVERIFIED'}
    }
    foreach($row in @($Rows|Sort-Object @{e={$_.relative.Length};Descending=$true})){
        $to=if($row.relative){Join-Path $Target $row.relative}else{$Target}
        if($row.directory){
            [IO.Directory]::SetCreationTimeUtc($to,[DateTime]::Parse($row.createdUtc).ToUniversalTime())
            [IO.Directory]::SetLastWriteTimeUtc($to,[DateTime]::Parse($row.writtenUtc).ToUniversalTime())
        }else{
            [IO.File]::SetCreationTimeUtc($to,[DateTime]::Parse($row.createdUtc).ToUniversalTime())
            [IO.File]::SetLastWriteTimeUtc($to,[DateTime]::Parse($row.writtenUtc).ToUniversalTime())
        }
        [IO.File]::SetAttributes($to,[IO.FileAttributes]$row.attributes)
    }
    Assert-MigrationTree $Source $Rows
    Assert-MigrationTree $Target $Rows
    & $verifier {param($p,$s) Assert-McpCcInstalledPrivateTree $p $s} $Target $operator.sid
}
function New-MigrationPrivateDirectory([string]$Path,[string]$AclSource) {
    if(Test-Path -LiteralPath $Path){throw 'MIGRATION_DESTINATION_EXISTS'}
    New-Item -ItemType Directory -Path $Path -ErrorAction Stop | Out-Null
    $acl=& $verifier {param($a,$s,$extra) Get-McpCcInstalledPrivateAcl $a $s $true $extra} (Get-Acl -LiteralPath $AclSource) $operator.sid (Get-Acl -LiteralPath $Path)
    Set-MigrationDacl $Path $acl
    if(-not(& $verifier {param($a,$b) Test-McpCcInstalledAclWrite $a $b} (Get-Acl -LiteralPath $Path) $acl)){throw 'MIGRATION_ACL_WRITE_UNVERIFIED'}
    & $verifier {param($p,$s) Assert-McpCcInstalledPrivatePath $p $s} $Path $operator.sid
}
function Assert-MigrationApprovalsIdle([string]$DataRoot,[string]$NodePath) {
    $path=Join-Path $DataRoot 'powershell-approval\receipts.jsonl'
    if(-not(Test-Path -LiteralPath $path)){throw 'MIGRATION_JOURNAL_MISSING'}
    # Reuse the existing Store schemas/hash-chain/transition checks and Review
    # projection. This process only reads; it never opens or recovers a Store.
    $raw=& $NodePath (Join-Path $PSScriptRoot 'check-migration-approvals.mjs') $path
    $code=$LASTEXITCODE
    $result=($raw -join [Environment]::NewLine)|ConvertFrom-Json
    if($code -ne 0 -or $result.ok -ne $true){throw [string]$result.code}
}
function Assert-MigrationStopped($Receipt) {
    Assert-NoTray
    foreach($identity in @($Receipt.oldCore,$Receipt.oldTunnel)){
        $p=Get-Process -Id $identity.pid -ErrorAction SilentlyContinue
        if($p){try{if($p.StartTime.ToUniversalTime().ToString('o') -ceq $identity.startedUtc){throw 'MIGRATION_OLD_PROCESS_ALIVE'}}finally{$p.Dispose()}}
    }
    if(@([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()|Where-Object Port -in @(18828,18829)).Count){throw 'MIGRATION_LISTENER_PRESENT'}
    if(Test-Path -LiteralPath 'C:\CodexBridge\powershell-approval\approval.lock'){throw 'MIGRATION_APPROVAL_LOCK_REMAINS'}
    $active=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
        $_.ProcessId -ne $PID -and $_.CommandLine -match '(?i)C:\\(CodexBridge|McpControlCenter)(\\|["\s])'
    })
    if($active.Count){throw 'MIGRATION_OLD_PATH_PROCESS_REFERENCE'}
}
function Get-MigrationPreCopyIncident($Release,$Previous,$SuccessorPlan=$null) {
    # One reviewed incident, not an UNKNOWN retry policy. Pins are part of the
    # immutable successor closure; no caller-supplied reset, path or hash override.
    $id='runtime-owner-20261022-r15'
    $receiptHash='013828ce8efa10c21277a728d4519814f6e5ab4f356cf400ef7d2ea91ad0947d'
    $manifestHash='1a7cf1845f43b2ed25320a6fbad96623999aceb8f942083180616fa3cf217ee4'
    $planHash='dfea28836cc350fccc0bbd5e653cb3311a6f409340476ca261be04fe2dad3b11'
    if($operator.isAdmin -or $Release.schemaVersion -ne 6 -or $Previous.schemaVersion -ne 5 -or
        $Release.releaseId -ceq $id -or $Previous.releaseId -cne 'normal-direct-20261022-r12' -or
        $Release.state.operatorSid -cne $operator.sid -or $Previous.state.operatorSid -cne $operator.sid){throw 'MIGRATION_INCIDENT_RELEASE_REJECTED'}
    $ccLocal=Join-Path $Release.legacyWorkspaceRoot 'mcp_control_center\.local'
    $bridgeParent=Join-Path $Release.legacyWorkspaceRoot 'codex_bridge\.local\migration-backups'
    $ccBackup=Join-Path $ccLocal ('migration-backups\'+$id)
    $bridgeBackup=Join-Path $bridgeParent $id
    $path=Join-Path $ccBackup 'migration.json'
    foreach($root in @($ccLocal,$bridgeParent)){
        & $verifier {param($p,$s) Assert-McpCcInstalledPrivateTree $p $s} $root $operator.sid
    }
    if((Get-FileHash -LiteralPath $path -ErrorAction Stop).Hash.ToLowerInvariant() -cne $receiptHash){throw 'MIGRATION_INCIDENT_RECEIPT_HASH_CHANGED'}
    $incident=Read-BoundedJson $path 1048576
    if($incident.contract -cne 'installed-runtime-migration-v1' -or $incident.phase -cne 'UNKNOWN' -or
        $incident.lastPhase -cne 'STOPPED_EXIT_TRAY' -or $incident.failure -cne 'MIGRATION_APPROVAL_NOT_TERMINAL' -or
        $null -ne $incident.verification){throw 'MIGRATION_INCIDENT_NOT_PRECOPY'}
    $old=Read-McpCcInstalledRelease (Join-Path (Join-Path (Split-Path -Parent $Previous.root) $id) 'mcp_control_center')
    Assert-McpCcInstalledClosure $old
    if($old.schemaVersion -ne 6 -or $old.releaseId -cne $id -or $old.state.operatorSid -cne $operator.sid -or
        $old.legacyWorkspaceRoot -cne $Release.legacyWorkspaceRoot -or
        (Get-FileHash -LiteralPath $old.sourcePath -ErrorAction Stop).Hash.ToLowerInvariant() -cne $manifestHash){throw 'MIGRATION_INCIDENT_MANIFEST_CHANGED'}
    Assert-MigrationReceipt $incident $old
    if($incident.planSha256 -cne $planHash -or $incident.plan.previousRoot -cne $Previous.root -or
        $incident.plan.ccLocal -cne $ccLocal -or $incident.plan.ccBackup -cne $ccBackup -or $incident.plan.bridgeBackup -cne $bridgeBackup -or
        $incident.plan.bridgeTarget -cne $Release.state.dataDir -or $incident.plan.ccTarget -cne $Release.state.ownerRoot){throw 'MIGRATION_INCIDENT_PLAN_CHANGED'}
    foreach($target in @($Release.state.dataDir,$Release.state.ownerRoot)){
        if(Test-Path -LiteralPath $target -ErrorAction Stop){throw 'MIGRATION_INCIDENT_TARGET_EXISTS'}
    }
    $upgrade=Get-InstalledUpgradeState $null $Previous.root -RequireSelected
    if((Get-StatePlanHash $upgrade) -cne (Get-StatePlanHash $incident.plan.previous)){throw 'MIGRATION_INCIDENT_PREVIOUS_CHANGED'}
    $settings=Join-Path $Release.legacyWorkspaceRoot 'codex_bridge\.local\tray-settings.json'
    if($Release.cutover.legacyStartupSha256 -cne $incident.plan.startupSha256 -or
        (Assert-InstalledUpgradeSelection $Previous) -cne $incident.plan.startupSha256 -or
        (Get-FileHash -LiteralPath $settings -ErrorAction Stop).Hash.ToLowerInvariant() -cne $incident.plan.settingsSha256 -or
        (Get-FileHash -LiteralPath (Join-Path $ccBackup 'startup.lnk') -ErrorAction Stop).Hash.ToLowerInvariant() -cne $incident.plan.startupSha256 -or
        (Get-FileHash -LiteralPath (Join-Path $bridgeBackup 'tray-settings.json') -ErrorAction Stop).Hash.ToLowerInvariant() -cne $incident.plan.settingsSha256){throw 'MIGRATION_INCIDENT_SELECTION_CHANGED'}
    $recovery=Join-Path $Previous.state.ownerRoot ('runtime-migration-'+$id+'-acl.json')
    & $verifier {param($p,$s) Assert-McpCcInstalledPrivatePath $p $s} $recovery $operator.sid
    if((Get-StatePlanHash (Read-BoundedJson $recovery 1048576)) -cne $planHash){throw 'MIGRATION_INCIDENT_ACL_RECOVERY_CHANGED'}
    foreach($row in $incident.plan.ancestors){
        $expected=New-Object Security.AccessControl.DirectorySecurity
        $expected.SetSecurityDescriptorSddlForm($row.after)
        if(-not(Test-MigrationAncestorAclWrite (Get-Acl -LiteralPath $row.path -ErrorAction Stop) $expected)){throw 'MIGRATION_INCIDENT_ANCESTOR_CHANGED'}
    }
    # Exact shapes, including directories: no extra backup, temp receipt, copied
    # state/manifest, runtime, alternate stream, reparse or unknown ACL is adopted.
    $ccNames=@('','migration-backups',('migration-backups\'+$id),('migration-backups\'+$id+'\migration.json'),('migration-backups\'+$id+'\startup.lnk'))
    $bridgeNames=@('',$id,($id+'\tray-settings.json'))
    if($SuccessorPlan){
        if($SuccessorPlan.releaseId -cne $Release.releaseId -or $SuccessorPlan.ccBackup -cne (Join-Path $ccLocal ('migration-backups\'+$Release.releaseId)) -or
            $SuccessorPlan.bridgeBackup -cne (Join-Path $bridgeParent $Release.releaseId)){throw 'MIGRATION_INCIDENT_SUCCESSOR_CHANGED'}
        $ccNames+=@(('migration-backups\'+$Release.releaseId),('migration-backups\'+$Release.releaseId+'\migration.json'),('migration-backups\'+$Release.releaseId+'\startup.lnk'))
        $bridgeNames+=@($Release.releaseId,($Release.releaseId+'\tray-settings.json'))
    }
    $inventories=@()
    foreach($pair in @(@($ccLocal,$ccNames),@($bridgeParent,$bridgeNames))){
        $rows=@(Get-MigrationTree $pair[0]);$names=@($pair[1])
        if($rows.Count -ne $names.Count){throw 'MIGRATION_INCIDENT_FOREIGN_ENTRY'}
        $directories=if($pair[0] -ceq $ccLocal){@('','migration-backups',('migration-backups\'+$id),('migration-backups\'+$Release.releaseId))}else{@('',$id,$Release.releaseId)}
        foreach($row in $rows){
            if($row.relative -cnotin $names -or $row.directory -ne ($row.relative -cin $directories)){throw 'MIGRATION_INCIDENT_FOREIGN_ENTRY'}
            $raw=New-Object Security.AccessControl.RawSecurityDescriptor($row.sddl)
            if($null -eq $raw.DiscretionaryAcl){throw 'MIGRATION_INCIDENT_ACL_UNKNOWN'}
            foreach($ace in $raw.DiscretionaryAcl){
                if($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback -or $ace.AceQualifier -notin @('AccessDenied','AccessAllowed')){throw 'MIGRATION_INCIDENT_ACL_UNKNOWN'}
            }
        }
        # Successor receipts and parent timestamps are expected to change during
        # its own stop. Historical bytes, types and ACLs remain bound separately.
        $successorPrefix=if($pair[0] -ceq $ccLocal){'migration-backups\'+$Release.releaseId}else{$Release.releaseId}
        $historical=@($rows|Where-Object {$_.relative -cne $successorPrefix -and -not $_.relative.StartsWith($successorPrefix+'\',[StringComparison]::Ordinal)}|Select-Object relative,directory,length,sha256,sddl)
        $inventories+=Get-StatePlanHash $historical
    }
    return [pscustomobject][ordered]@{receiptPath=$path;receiptSha256=$receiptHash;manifestSha256=$manifestHash;planSha256=$planHash;
        ccEvidenceSha256=$inventories[0];bridgeEvidenceSha256=$inventories[1]}
}

function Get-MigrationFreshBaseline($Release,$Previous) {
    $health=Get-Health -Idle;$status=Invoke-Controller (Join-Path $Previous.root 'codex_bridge') Status
    Assert-OwnedReady $status $health;Assert-RemoteReceiptsTerminal $Previous.state.ownerRoot
    Assert-HttpAuthentication -MigrationStoreStatus
    if(($health.jobs.total -isnot [int] -and $health.jobs.total -isnot [long]) -or $health.jobs.total -lt 0){throw 'MIGRATION_JOB_BASELINE_UNKNOWN'}
    if($health.buildId -cne $Release.cutover.rollbackBuildId){throw 'MIGRATION_BASELINE_BUILD_CHANGED'}
    $core=[ordered]@{pid=$health.pid;startedUtc=(Get-Process -Id $health.pid -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')}
    $tunnel=[ordered]@{pid=$status.after.tunnel.pid;startedUtc=(Get-Process -Id $status.after.tunnel.pid -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')}
    # Never read a running Store's locked files. Bind their metadata, then use
    # the existing journal checker after the canonical owner closes normally.
    $locked=@('powershell-approval\receipts.jsonl','powershell-approval\approval.lock')
    $metadata=@(foreach($relative in $locked){
        $path=Join-Path $Previous.state.dataDir $relative
        & $verifier {param($p,$s) Assert-McpCcInstalledPrivatePath $p $s} $path $operator.sid
        $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'MIGRATION_STORE_METADATA_UNKNOWN'}
        [pscustomobject][ordered]@{relative=$relative;length=$item.Length;createdUtc=$item.CreationTimeUtc.ToString('o');writtenUtc=$item.LastWriteTimeUtc.ToString('o');sddl=(Get-Acl -LiteralPath $path -ErrorAction Stop).Sddl}
    })
    $data=Get-MigrationTree $Previous.state.dataDir -ExcludeRelative $locked
    # The verified installed tunnel owns this exact --log.file while running
    # (New-CbInstalledRuntimeContext / Start-CbInstalledTunnel). Do not open its
    # content or bind append-varying length/write time into the live Plan hash.
    # Retain identity/ACL metadata; all authority and history remain fully hashed.
    # After normal shutdown and Tray exit, the existing stopped owner seal and
    # backup/copy/cleanup paths use Get-MigrationTree with NO exclusions.
    $logRelative='installed-bridge\'+$Previous.releaseId+'\tunnel-client.log'
    $logPath=Join-Path $Previous.state.ownerRoot $logRelative
    & $verifier {param($p,$s) Assert-McpCcInstalledPrivatePath $p $s} $logPath $operator.sid
    $logItem=Get-Item -LiteralPath $logPath -Force -ErrorAction Stop
    if($logItem.PSIsContainer -or ($logItem.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'MIGRATION_TUNNEL_METADATA_UNKNOWN'}
    if(@(Get-Item -LiteralPath $logPath -Force -Stream * -ErrorAction Stop | Where-Object Stream -ne ':$DATA').Count){throw 'MIGRATION_ALTERNATE_STREAM_REQUIRES_REVIEW'}
    $logMetadata=[pscustomobject][ordered]@{relative=$logRelative;directory=$false;createdUtc=$logItem.CreationTimeUtc.ToString('o');
        attributes=[int]$logItem.Attributes;sddl=(Get-Acl -LiteralPath $logPath -ErrorAction Stop).Sddl}
    $owner=@(Get-MigrationTree $Previous.state.ownerRoot -ExcludeRelative @($logRelative)) + @($logMetadata)
    # The selected Tray periodically publishes state.json through the existing
    # atomic writer. Its content/size/write time and the parent's write time are
    # observations, not authority. Keep exact entries, identity, type, attributes
    # and ACLs; all other content still binds the live plan. This projection is
    # used only here: the stopped seal/copy/verify/cleanup inventories remain full.
    foreach($row in $owner){
        if($row.relative -ceq ''){$row.writtenUtc=$null}
        elseif($row.relative -ceq 'state.json' -and -not $row.directory){
            $row.length=0L;$row.sha256=$null;$row.writtenUtc=$null
        }
    }
    $after=Get-Health -Idle
    if($after.pid -ne $health.pid -or $after.buildId -cne $health.buildId -or $after.jobs.total -ne $health.jobs.total){throw 'MIGRATION_BASELINE_CHANGED'}
    return [pscustomobject][ordered]@{jobCount=$health.jobs.total;buildId=$health.buildId;oldCore=$core;oldTunnel=$tunnel;
        dataSha256=(Get-StatePlanHash $data);ownerSha256=(Get-StatePlanHash $owner);storeMetadataSha256=(Get-StatePlanHash $metadata)}
}

function Assert-MigrationRecoveryStopBaseline($Receipt) {
    if(-not $Receipt.PSObject.Properties['stoppedDataSha256'] -or $Receipt.stoppedDataSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        $Receipt.jobCount -ne $Receipt.plan.baseline.jobCount){throw 'MIGRATION_BASELINE_CHANGED'}
    foreach($name in @('oldCore','oldTunnel')){
        if($Receipt.$name.pid -ne $Receipt.plan.baseline.$name.pid -or
            $Receipt.$name.startedUtc -cne $Receipt.plan.baseline.$name.startedUtc){throw 'MIGRATION_BASELINE_CHANGED'}
    }
}

function Get-RuntimeMigrationPlan($Release,$Previous,[switch]$RecoverR15PreCopy) {
    if($Release.schemaVersion -ne 6 -or $Previous.schemaVersion -ne 5 -or $Release.releaseId -ceq $Previous.releaseId -or
        $Release.legacyWorkspaceRoot -cne $Previous.legacyWorkspaceRoot -or $Release.state.operatorSid -cne $operator.sid){throw 'MIGRATION_RELEASE_PAIR_REJECTED'}
    foreach($field in @('operatorSid','userProfile','localAppData','projectsFile','codexHome')){
        if($Release.state.$field -cne $Previous.state.$field){throw 'MIGRATION_IDENTITY_CHANGED'}
    }
    if($Release.deployment.projectsSha256 -cne $Previous.deployment.projectsSha256 -or $Release.deployment.credentialSha256 -cne $Previous.deployment.credentialSha256 -or
        $Release.cutover.tunnelProfileSha256 -cne $Previous.cutover.tunnelProfileSha256 -or $Release.cutover.httpTokenSha256 -cne $Previous.cutover.httpTokenSha256){throw 'MIGRATION_CONFIGURATION_CHANGED'}
    $upgrade=Get-InstalledUpgradeState $null $Previous.root -RequireSelected
    foreach($scope in @('Process','User','Machine')){foreach($name in @('CODEX_BRIDGE_DATA_DIR','MCP_CONTROL_CENTER_DATA_DIR')){
        if([Environment]::GetEnvironmentVariable($name,$scope)){throw 'MIGRATION_EXPLICIT_ENV_REQUIRES_REVIEW'}
    }}
    $workspace=$Release.legacyWorkspaceRoot
    $ancestors=@(foreach($path in @($workspace,(Join-Path $workspace 'codex_bridge'),(Join-Path $workspace 'mcp_control_center'),(Join-Path $workspace 'codex_bridge\.local'))){
        $acl=Get-Acl -LiteralPath $path -ErrorAction Stop
        [pscustomobject][ordered]@{path=$path;before=$acl.Sddl;after=(Get-MigrationAncestorAcl $acl $operator.sid).Sddl}
    })
    $ccLocal=Join-Path $workspace 'mcp_control_center\.local'
    $incident=$null
    if($RecoverR15PreCopy){$incident=Get-MigrationPreCopyIncident $Release $Previous}
    elseif(Test-Path -LiteralPath $ccLocal){throw 'MIGRATION_CC_LOCAL_EXISTS_REQUIRES_REVIEW'}
    $bridgeBackup=Join-Path $workspace ('codex_bridge\.local\migration-backups\'+$Release.releaseId)
    $ccBackup=Join-Path $workspace ('mcp_control_center\.local\migration-backups\'+$Release.releaseId)
    foreach($path in @($Release.state.ownerRoot,$Release.state.dataDir,$bridgeBackup,$ccBackup)){
        if(Test-Path -LiteralPath $path){throw 'MIGRATION_DESTINATION_EXISTS'}
    }
    $settings=Join-Path $workspace 'codex_bridge\.local\tray-settings.json'
    if(-not(Test-Path -LiteralPath $settings)){throw 'MIGRATION_SETTINGS_REQUIRED'}
    $plan=[pscustomobject][ordered]@{contract='installed-runtime-migration-plan-v1';releaseId=$Release.releaseId;previousRoot=$Previous.root;
        manifestSha256=(Get-FileHash -LiteralPath $Release.sourcePath).Hash.ToLowerInvariant();previous=$upgrade;
        startupSha256=(Assert-InstalledUpgradeSelection $Previous);settingsSha256=(Get-FileHash -LiteralPath $settings).Hash.ToLowerInvariant();
        ancestors=$ancestors;ccLocal=$ccLocal;bridgeBackup=$bridgeBackup;ccBackup=$ccBackup;bridgeTarget=$Release.state.dataDir;ccTarget=$Release.state.ownerRoot}
    if($incident){
        $plan|Add-Member NoteProperty incident $incident
        $plan|Add-Member NoteProperty baseline (Get-MigrationFreshBaseline $Release $Previous)
    }
    return $plan
}
function Assert-MigrationReceipt($Receipt,$Release) {
    if($Receipt.contract -cne 'installed-runtime-migration-v1' -or $Receipt.plan.releaseId -cne $Release.releaseId -or
        $Receipt.plan.manifestSha256 -cne (Get-FileHash -LiteralPath $Release.sourcePath).Hash.ToLowerInvariant() -or
        $Receipt.planSha256 -cne (Get-StatePlanHash $Receipt.plan) -or
        $Receipt.plan.bridgeTarget -cne $Release.state.dataDir -or $Receipt.plan.ccTarget -cne $Release.state.ownerRoot){throw 'MIGRATION_RECEIPT_CHANGED'}
}
function Set-MigrationStartup([string]$ManagerRoot) {
    $startup=Join-Path ([Environment]::GetFolderPath('Startup')) 'MCP Control Center.lnk'
    $shell=New-Object -ComObject WScript.Shell
    try{$link=$shell.CreateShortcut($startup);$link.TargetPath=$ps;$link.Arguments='-NoProfile -File "'+(Join-Path $ManagerRoot 'scripts\tray.ps1')+'" -AutoReconcile';$link.WorkingDirectory=$ManagerRoot;$link.Save()}
    finally{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)}
}
function Test-MigrationLive($Release,$Receipt) {
    $binding=Get-McpCcInstalledBridgeBinding (Join-Path $Release.root 'codex_bridge')
    Assert-McpCcInstalledSelection $binding
    $health=Get-Health -Idle;$status=Invoke-Controller (Join-Path $Release.root 'codex_bridge') Status
    Assert-OwnedReady $status $health;Assert-HttpAuthentication -MigrationStoreStatus
    if($health.jobs.total -ne $Receipt.jobCount){throw 'MIGRATION_JOB_COUNT_CHANGED'}
    if((Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:18829/readyz' -TimeoutSec 3 -MaximumRedirection 0).Content.Trim() -notin @('ready','ok')){throw 'MIGRATION_TUNNEL_NOT_READY'}
    # Retained Job/Approval/Journal bytes must agree with the stopped backup.
    $dataRows=Read-BoundedJson (Join-Path $Receipt.plan.bridgeBackup 'manifest.json') 16777216
    $excluded=@('powershell-approval\approval.lock','powershell-approval\receipts.jsonl')
    $actual=@(Get-MigrationTree $Release.state.dataDir -ExcludeRelative $excluded)
    if((Get-MigrationContentHash $actual) -cne (Get-MigrationContentHash @($dataRows|Where-Object relative -cnotin $excluded))){throw 'MIGRATION_DATA_CHANGED_REQUIRES_REVIEW'}
    $journal=@($dataRows|Where-Object relative -ceq 'powershell-approval\receipts.jsonl')
    if($journal.Count -ne 1 -or (Get-Item -LiteralPath (Join-Path $Release.state.dataDir $journal[0].relative)).Length -ne $journal[0].length){throw 'MIGRATION_JOURNAL_CHANGED_REQUIRES_REVIEW'}
    return [pscustomobject]@{pid=$health.pid;buildId=$health.buildId;tunnelPid=$status.after.tunnel.pid;jobCount=$health.jobs.total;verifiedUtc=[DateTime]::UtcNow.ToString('o')}
}
function Remove-MigrationVerifiedTree([string]$Root,$Rows) {
    if($Root -cnotin @('C:\CodexBridge','C:\McpControlCenter')){throw 'MIGRATION_DELETE_SCOPE_REJECTED'}
    Assert-MigrationTree $Root $Rows
    # Exact known entries, deepest first; never recurse, follow a link, force an
    # ACL, clear attributes, or delete a file that changed after verification.
    foreach($row in @($Rows|Sort-Object @{e={$_.relative.Length};Descending=$true},relative)){
        $path=if($row.relative){[IO.Path]::GetFullPath((Join-Path $Root $row.relative))}else{$Root}
        if($path -cne $Root -and -not $path.StartsWith($Root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'MIGRATION_DELETE_SCOPE_REJECTED'}
        $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'MIGRATION_REPARSE_REJECTED'}
        if(-not $row.directory -and (Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant() -cne $row.sha256){throw 'MIGRATION_CONTENT_CHANGED'}
        if($row.directory -and @(Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop).Count){throw 'MIGRATION_DIRECTORY_NOT_EMPTY'}
        Remove-Item -LiteralPath $path -ErrorAction Stop
    }
}

function Invoke-InstalledRuntimeMigration([string]$Verb,[string]$TargetReleaseRoot,[string]$PreviousRoot,[string]$ExpectedPlanHash,[switch]$RecoverR15PreCopy) {
    if(-not $TargetReleaseRoot){throw 'RELEASE_ROOT_REQUIRED'}
    $targetManager=Join-Path ([IO.Path]::GetFullPath($TargetReleaseRoot)) 'mcp_control_center'
    # Execution stays in the immutable installed operator closure.
    if($manager -ine $targetManager){throw 'MIGRATION_USE_INSTALLED_OPERATOR'}
    Assert-McpCcProtectedCodePath (Join-Path $targetManager 'src\McpControlCenter.InstalledRelease.psm1')
    $script:verifier=Import-Module (Join-Path $targetManager 'src\McpControlCenter.InstalledRelease.psm1') -Force -PassThru
    $release=Read-McpCcInstalledRelease $targetManager;Assert-McpCcInstalledClosure $release
    if($release.schemaVersion -ne 6 -or $release.state.operatorSid -cne $operator.sid){throw 'MIGRATION_RELEASE_REJECTED'}
    $receiptPath=Join-Path $release.legacyWorkspaceRoot ('mcp_control_center\.local\migration-backups\'+$release.releaseId+'\migration.json')
    if($RecoverR15PreCopy -and ($Verb -notin @('MigrationPlan','MigrationApply') -or $release.releaseId -ceq 'runtime-owner-20261022-r15')){throw 'MIGRATION_INCIDENT_ACTION_REJECTED'}
    $lock=New-Object Threading.Mutex($false,'Local\McpCcInstalledOperator');$held=$false;$receipt=$null;$mutationStarted=$false
    try{
        try{$held=$lock.WaitOne(0)}catch [Threading.AbandonedMutexException]{$held=$true}
        if(-not $held){throw 'CUTOVER_BUSY'}
        if(Test-Path -LiteralPath $receiptPath){
            & $verifier {param($p,$s) Assert-McpCcInstalledPrivatePath $p $s} $receiptPath $operator.sid
            $receipt=Read-BoundedJson $receiptPath 1048576;Assert-MigrationReceipt $receipt $release
        }
        if($Verb -eq 'MigrationPlan' -or ($Verb -eq 'MigrationApply' -and -not $receipt)){
            if($receipt){throw 'MIGRATION_PLAN_REQUIRES_FRESH_RELEASE'}
            if(-not $PreviousRoot){throw 'MIGRATION_PREVIOUS_RELEASE_REQUIRED'}
            $previous=Read-McpCcInstalledRelease (Join-Path $PreviousRoot 'mcp_control_center')
            $plan=Get-RuntimeMigrationPlan $release $previous -RecoverR15PreCopy:$RecoverR15PreCopy;$hash=Get-StatePlanHash $plan
            if($Verb -eq 'MigrationPlan'){
                [pscustomobject]@{phase='MIGRATION_PLAN_READY';statePlanSha256=$hash;ancestors=@($plan.ancestors.path);targets=@($plan.bridgeTarget,$plan.ccTarget);
                    incident=$(if($RecoverR15PreCopy){$plan.incident}else{$null});baseline=$(if($RecoverR15PreCopy){$plan.baseline}else{$null});productionTouched=$false}|ConvertTo-Json -Depth 5
                return
            }
            if($ExpectedPlanHash -cne $hash){throw 'STATE_PLAN_CHANGED_NO_MUTATION'}
            $health=Get-Health -Idle;$before=Invoke-Controller (Join-Path $previous.root 'codex_bridge') Status
            Assert-OwnedReady $before $health;Assert-RemoteReceiptsTerminal $previous.state.ownerRoot
            if($RecoverR15PreCopy -and (Get-StatePlanHash (Get-MigrationFreshBaseline $release $previous)) -cne (Get-StatePlanHash $plan.baseline)){throw 'MIGRATION_BASELINE_CHANGED'}
            if($health.buildId -cne $release.cutover.rollbackBuildId){throw 'MIGRATION_BASELINE_BUILD_CHANGED'}
            $bytes=(Get-MigrationTreeBytes $previous.state.dataDir)+(Get-MigrationTreeBytes $previous.state.ownerRoot)
            if((Get-PSDrive C).Free -lt (2*$bytes+1073741824)){throw 'MIGRATION_BACKUP_SPACE_REQUIRED'}
            # Original ACLs are durable under the still-protected old owner before
            # touching any ancestor. A partial failure remains inspectable there.
            $aclRecovery=Join-Path $previous.state.ownerRoot ('runtime-migration-'+$release.releaseId+'-acl.json')
            if(Test-Path -LiteralPath $aclRecovery){throw 'MIGRATION_RECOVERY_EXISTS_DO_NOT_RETRY'}
            $mutationStarted=$true
            Write-Receipt $aclRecovery $plan
            # Protect children first so subsequent ancestor edits cannot alter
            # their planned inherited ACLs or propagate into source descendants.
            foreach($row in @($plan.ancestors|Sort-Object @{e={$_.path.Length};Descending=$true})){
                if((Get-Acl -LiteralPath $row.path).Sddl -cne $row.before){throw 'MIGRATION_ANCESTOR_CHANGED'}
                $acl=Get-MigrationAncestorAcl (Get-Acl -LiteralPath $row.path) $operator.sid
                Set-MigrationDacl $row.path $acl
                if(-not(Test-MigrationAncestorAclWrite (Get-Acl -LiteralPath $row.path) $acl)){throw 'MIGRATION_ANCESTOR_WRITE_UNVERIFIED'}
            }
            if(-not $RecoverR15PreCopy){New-MigrationPrivateDirectory $plan.ccLocal $previous.state.ownerRoot}
            foreach($pair in @(@($plan.bridgeBackup,$previous.state.dataDir),@($plan.ccBackup,$previous.state.ownerRoot))){
                $parent=Split-Path -Parent $pair[0]
                if(-not(Test-Path -LiteralPath $parent)){New-MigrationPrivateDirectory $parent $pair[1]}
                New-MigrationPrivateDirectory $pair[0] $pair[1]
            }
            $startup=Join-Path ([Environment]::GetFolderPath('Startup')) 'MCP Control Center.lnk'
            Copy-Item -LiteralPath $startup -Destination (Join-Path $plan.ccBackup 'startup.lnk')
            Copy-Item -LiteralPath (Join-Path $release.legacyWorkspaceRoot 'codex_bridge\.local\tray-settings.json') -Destination (Join-Path $plan.bridgeBackup 'tray-settings.json')
            $receipt=[pscustomobject][ordered]@{contract='installed-runtime-migration-v1';phase='STOPPING';plan=$plan;planSha256=$hash;jobCount=$health.jobs.total;
                oldCore=@{pid=$health.pid;startedUtc=(Get-Process -Id $health.pid).StartTime.ToUniversalTime().ToString('o')};
                oldTunnel=@{pid=$before.after.tunnel.pid;startedUtc=(Get-Process -Id $before.after.tunnel.pid).StartTime.ToUniversalTime().ToString('o')};verification=$null;failure=$null}
            if($RecoverR15PreCopy){
                foreach($name in @('oldCore','oldTunnel')){
                    if($receipt.$name.pid -ne $plan.baseline.$name.pid -or $receipt.$name.startedUtc -cne $plan.baseline.$name.startedUtc){throw 'MIGRATION_BASELINE_CHANGED'}
                }
                if($receipt.jobCount -ne $plan.baseline.jobCount){throw 'MIGRATION_BASELINE_CHANGED'}
            }
            Write-Receipt $receiptPath $receipt
            $stopped=Invoke-Controller (Join-Path $previous.root 'codex_bridge') ShutdownRuntime
            if($stopped.after.server.ownership -cne 'Stopped' -or $stopped.after.tunnel.ownership -cne 'Stopped'){throw 'MIGRATION_STOP_UNKNOWN'}
            if($RecoverR15PreCopy){
                # Mint a new post-stop data baseline after normal shutdown writes.
                # The old incident's job count, PIDs and data are never reused.
                Assert-MigrationApprovalsIdle $previous.state.dataDir $release.dependencies.node.path
                $receipt|Add-Member NoteProperty stoppedDataSha256 (Get-StatePlanHash (Get-MigrationTree $previous.state.dataDir))
            }
            $receipt.phase='STOPPED_EXIT_TRAY';Write-Receipt $receiptPath $receipt
            [pscustomobject]@{phase=$receipt.phase;next='Exit Control Center UI only, then run MigrationApply again';receipt=$receiptPath}|ConvertTo-Json
            return
        }
        if(-not $receipt){throw 'MIGRATION_RECEIPT_REQUIRED'}
        if($Verb -eq 'MigrationApply'){
            if($receipt.phase -cne 'STOPPED_EXIT_TRAY'){throw 'MIGRATION_PHASE_REJECTED_NO_RETRY'}
            Assert-MigrationStopped $receipt
            if($receipt.plan.PSObject.Properties['incident']){
                if(-not $RecoverR15PreCopy){throw 'MIGRATION_INCIDENT_FLAG_REQUIRED'}
                $previous=Read-McpCcInstalledRelease (Join-Path $receipt.plan.previousRoot 'mcp_control_center')
                if((Get-StatePlanHash (Get-MigrationPreCopyIncident $release $previous $receipt.plan)) -cne (Get-StatePlanHash $receipt.plan.incident)){throw 'MIGRATION_INCIDENT_EVIDENCE_CHANGED'}
                Assert-MigrationRecoveryStopBaseline $receipt
                if((Get-StatePlanHash (Get-MigrationTree $previous.state.dataDir)) -cne $receipt.stoppedDataSha256){throw 'MIGRATION_STOPPED_DATA_CHANGED'}
                # The Tray remains the owner until its normal Exit. Seal its
                # current state only after Assert-MigrationStopped proves that
                # final writer is gone; do not reuse the pre-exit owner snapshot.
                Assert-RemoteReceiptsTerminal $previous.state.ownerRoot
                $receipt|Add-Member NoteProperty stoppedOwnerSha256 (Get-StatePlanHash (Get-MigrationTree $previous.state.ownerRoot)) -Force
            }elseif($RecoverR15PreCopy){throw 'MIGRATION_INCIDENT_PLAN_REQUIRED'}
            Assert-MigrationApprovalsIdle 'C:\CodexBridge' $release.dependencies.node.path
            $mutationStarted=$true
            $receipt.phase='COPYING';Write-Receipt $receiptPath $receipt
            foreach($pair in @(@('C:\CodexBridge',$receipt.plan.bridgeBackup,$receipt.plan.bridgeTarget),@('C:\McpControlCenter',$receipt.plan.ccBackup,$receipt.plan.ccTarget))){
                $rows=Get-MigrationTree $pair[0]
                if($receipt.plan.PSObject.Properties['incident']){
                    $stoppedHash=if($pair[0] -ceq 'C:\CodexBridge'){$receipt.stoppedDataSha256}else{$receipt.stoppedOwnerSha256}
                    if((Get-StatePlanHash $rows) -cne $stoppedHash){throw 'MIGRATION_STOPPED_SOURCE_CHANGED'}
                }
                Write-Receipt (Join-Path $pair[1] 'manifest.json') @($rows)
                Copy-MigrationTree $pair[0] (Join-Path $pair[1] 'state') $rows
                Copy-MigrationTree $pair[0] $pair[2] $rows
            }
            $receipt.phase='COPIED';Write-Receipt $receiptPath $receipt
            $runtime=Join-Path $release.state.ownerRoot ('installed-bridge\'+$release.releaseId)
            New-MigrationPrivateDirectory $runtime $release.state.ownerRoot
            $previousRuntime=Join-Path $release.state.ownerRoot ('installed-bridge\'+(Split-Path -Leaf $receipt.plan.previousRoot))
            $snapshotRows=Get-MigrationTree (Join-Path $previousRuntime 'deployment')
            Copy-MigrationTree (Join-Path $previousRuntime 'deployment') (Join-Path $runtime 'deployment') $snapshotRows
            $bindingPlan=[ordered]@{releaseId=$release.releaseId;manifestSha256=$receipt.plan.manifestSha256;migrationReceipt=$receiptPath;migrationPlanSha256=$receipt.planSha256}
            Write-Receipt (Join-Path $runtime 'state-acl-before.json') $bindingPlan
            Write-Receipt (Join-Path $runtime 'state-binding.json') @{contract='installed-state-binding-v1';phase='STATE_BOUND';planSha256=(Get-StatePlanHash $bindingPlan);backup=(Join-Path $runtime 'state-acl-before.json')}
            $binding=Get-McpCcInstalledBridgeBinding (Join-Path $release.root 'codex_bridge')
            $settingsPath=Join-Path $release.legacyWorkspaceRoot 'codex_bridge\.local\tray-settings.json'
            if((Get-FileHash -LiteralPath $settingsPath).Hash.ToLowerInvariant() -cne $receipt.plan.settingsSha256){throw 'MIGRATION_SETTINGS_CHANGED'}
            $settings=Read-BoundedJson $settingsPath
            $settings|Add-Member -NotePropertyName dataDir -NotePropertyValue $release.state.dataDir -Force
            # Existing source settings retain their original ACL; do not apply a
            # receipt-directory ACL policy to unrelated local configuration.
            [IO.File]::WriteAllText($settingsPath,($settings|ConvertTo-Json -Depth 12),$utf8)
            Set-MigrationStartup $targetManager
            $receipt.phase='STARTING';Write-Receipt $receiptPath $receipt
            $null=Start-SelectedTray $targetManager
            $deadline=[DateTime]::UtcNow.AddSeconds(30)
            do {Start-Sleep -Milliseconds 300;try{Assert-McpCcInstalledSelection $binding;break}catch{if([DateTime]::UtcNow -gt $deadline){throw 'MIGRATION_OWNER_START_UNKNOWN'}}}while($true)
            $null=Invoke-Controller (Join-Path $release.root 'codex_bridge') EnsureRunning
            $receipt.verification=Test-MigrationLive $release $receipt
            # Preserve the existing accepted-release evidence consumed by future
            # same-layout upgrades. This does not permit a v6-to-v5 state reuse.
            Write-Receipt (Join-Path $runtime 'operator-cutover.json') @{contract='mcpcc-installed-cutover-v1';phase='LOCAL_ACCEPTED';
                releaseId=$release.releaseId;operatorSid=$operator.sid;newPid=$receipt.verification.pid;newBuildId=$receipt.verification.buildId;
                migrationReceipt=$receiptPath;utc=[DateTime]::UtcNow.ToString('o')}
            $receipt.phase='LOCAL_ACCEPTED';Write-Receipt $receiptPath $receipt
        } elseif($Verb -eq 'MigrationVerify'){
            if($receipt.phase -notin @('LOCAL_ACCEPTED','VERIFIED')){throw 'MIGRATION_PHASE_REJECTED'}
            $mutationStarted=$true
            $receipt.verification=Test-MigrationLive $release $receipt
            foreach($pair in @(@($receipt.plan.bridgeBackup,'C:\CodexBridge'),@($receipt.plan.ccBackup,'C:\McpControlCenter'))){
                $rows=Read-BoundedJson (Join-Path $pair[0] 'manifest.json') 16777216
                Assert-MigrationTree (Join-Path $pair[0] 'state') $rows;Assert-MigrationTree $pair[1] $rows
            }
            $receipt.phase='VERIFIED';Write-Receipt $receiptPath $receipt
        } elseif($Verb -eq 'MigrationCleanup'){
            if($receipt.phase -cne 'VERIFIED' -or $ExpectedPlanHash -cne (Get-FileHash -LiteralPath $receiptPath).Hash.ToLowerInvariant()){throw 'MIGRATION_VERIFIED_RECEIPT_HASH_REQUIRED'}
            $mutationStarted=$true
            $null=Test-MigrationLive $release $receipt
            foreach($scope in @('Process','User','Machine')){foreach($name in @('CODEX_BRIDGE_DATA_DIR','MCP_CONTROL_CENTER_DATA_DIR')){
                $value=[Environment]::GetEnvironmentVariable($name,$scope)
                if($value -and $value -match '(?i)^C:\\(CodexBridge|McpControlCenter)(\\|$)'){throw 'MIGRATION_OLD_ENV_REFERENCE'}
            }}
            if(@(Get-CimInstance Win32_Process|Where-Object {$_.ProcessId -ne $PID -and $_.CommandLine -match '(?i)C:\\(CodexBridge|McpControlCenter)(\\|["\s])'}).Count){throw 'MIGRATION_OLD_PATH_PROCESS_REFERENCE'}
            # Verify BOTH recovery copies before deleting either original root.
            $dataRows=Read-BoundedJson (Join-Path $receipt.plan.bridgeBackup 'manifest.json') 16777216
            $ownerRows=Read-BoundedJson (Join-Path $receipt.plan.ccBackup 'manifest.json') 16777216
            Assert-MigrationTree (Join-Path $receipt.plan.bridgeBackup 'state') $dataRows
            Assert-MigrationTree (Join-Path $receipt.plan.ccBackup 'state') $ownerRows
            Assert-MigrationTree 'C:\CodexBridge' $dataRows;Assert-MigrationTree 'C:\McpControlCenter' $ownerRows
            $receipt.phase='CLEANING';Write-Receipt $receiptPath $receipt
            Remove-MigrationVerifiedTree 'C:\CodexBridge' $dataRows
            Remove-MigrationVerifiedTree 'C:\McpControlCenter' $ownerRows
            $receipt.phase='COMPLETE';Write-Receipt $receiptPath $receipt
        } elseif($Verb -eq 'MigrationRollback'){
            # Before new startup the originals are untouched, so restoration loses
            # no data. Once startup was attempted, require explicit incident review
            # of both stores; never overwrite possibly newer jobs/approval receipts.
            $preStartFailure=$receipt.phase -ceq 'UNKNOWN' -and $receipt.PSObject.Properties['lastPhase'] -and $receipt.lastPhase -in @('COPYING','COPIED')
            if($receipt.phase -notin @('STOPPED_EXIT_TRAY','COPIED') -and -not $preStartFailure){throw 'MIGRATION_ROLLBACK_REQUIRES_STATE_REVIEW'}
            Assert-MigrationStopped $receipt
            $mutationStarted=$true
            $startup=Join-Path ([Environment]::GetFolderPath('Startup')) 'MCP Control Center.lnk'
            $backup=Join-Path $receipt.plan.ccBackup 'startup.lnk'
            if((Get-FileHash -LiteralPath $backup).Hash.ToLowerInvariant() -cne $receipt.plan.startupSha256){throw 'MIGRATION_STARTUP_BACKUP_CHANGED'}
            $settingsBackup=Join-Path $receipt.plan.bridgeBackup 'tray-settings.json'
            if((Get-FileHash -LiteralPath $settingsBackup).Hash.ToLowerInvariant() -cne $receipt.plan.settingsSha256){throw 'MIGRATION_SETTINGS_BACKUP_CHANGED'}
            Copy-Item -LiteralPath $settingsBackup -Destination (Join-Path $release.legacyWorkspaceRoot 'codex_bridge\.local\tray-settings.json') -Force
            Copy-Item -LiteralPath $backup -Destination $startup -Force
            $oldManager=Join-Path $receipt.plan.previousRoot 'mcp_control_center'
            $null=Start-SelectedTray $oldManager
            Start-Sleep -Seconds 2
            $null=Invoke-Controller (Join-Path $receipt.plan.previousRoot 'codex_bridge') EnsureRunning
            $health=Get-Health -Idle;Assert-OwnedReady (Invoke-Controller (Join-Path $receipt.plan.previousRoot 'codex_bridge') Status) $health
            if($health.buildId -cne $release.cutover.rollbackBuildId){throw 'MIGRATION_ROLLBACK_BUILD_CHANGED'}
            $receipt.phase='ROLLED_BACK';Write-Receipt $receiptPath $receipt
        }
        [pscustomobject]@{phase=$receipt.phase;receipt=$receiptPath;receiptSha256=(Get-FileHash -LiteralPath $receiptPath).Hash.ToLowerInvariant();verification=$receipt.verification;oldRootsExist=@((Test-Path -LiteralPath 'C:\CodexBridge'),(Test-Path -LiteralPath 'C:\McpControlCenter'))}|ConvertTo-Json -Depth 5
    } catch {
        if($mutationStarted -and $receipt -and $_.Exception.Message -notin @('CLOSE_CONTROL_CENTER_UI_ONLY_THEN_REPEAT','MIGRATION_PHASE_REJECTED_NO_RETRY','MIGRATION_ROLLBACK_REQUIRES_STATE_REVIEW')){
            $receipt.failure=[string]$_.Exception.Message
            # Preserve the last durable phase for incident review. Never turn an
            # unknown operation into a resumable phase or silently restore data.
            $receipt|Add-Member NoteProperty lastPhase $receipt.phase -Force;$receipt.phase='UNKNOWN'
            Write-Receipt $receiptPath $receipt
        }
        throw
    } finally {if($held){$lock.ReleaseMutex()};$lock.Dispose()}
}
