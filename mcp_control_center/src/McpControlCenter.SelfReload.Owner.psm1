Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'McpControlCenter.Core.psm1')
Import-Module (Join-Path $PSScriptRoot 'McpControlCenter.SelfReload.psm1')
Import-Module (Join-Path $PSScriptRoot 'McpControlCenter.InstalledRelease.psm1')

function Assert-R1ProtectedPath([string]$Path, [string]$OwnerSid, [switch]$Private) {
    if (-not $Private) { Assert-McpCcProtectedCodePath $Path; return }
    $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'PROTECTED_INSTALL_REQUIRED' }
    $acl=Get-Acl -LiteralPath $Path
    $trusted=if ($Private) { @($OwnerSid,'S-1-5-18','S-1-5-32-544') } else { @('S-1-5-18','S-1-5-32-544') }
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw 'PROTECTED_INSTALL_REQUIRED' }
    $write=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted -and
            ($Private -or ($rule.FileSystemRights -band $write))) { throw 'PROTECTED_INSTALL_REQUIRED' }
    }
}
function Get-R1Deployment([string]$RuntimeRoot, $Manifest) {
    if ($Manifest.schemaVersion -eq 4) {
        Assert-McpCcInstalledClosure $Manifest.installedRelease
        Assert-McpCcInstalledActivation $Manifest
        # Local installed deployment is independent of remote authorization. This owner
        # has no verified ChatGPT WebAuthn ceremony yet, so it never opens a grant pipe.
        throw 'HOST_NOT_VERIFIED'
    }
    $root=Join-Path $RuntimeRoot 'remote-self-reload-r1'
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA) -or
        [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\') -ine [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'McpControlCenter')).TrimEnd('\')) { throw 'DEFAULT_PROTECTED_STATE_REQUIRED' }
    $policyPath=Join-Path $root 'policy.json'
    if (-not (Test-Path -LiteralPath $policyPath -PathType Leaf)) { throw 'NOT_DEPLOYED' }
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent(); $owner=$identity.User.Value
    $principal=New-Object Security.Principal.WindowsPrincipal($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'NON_ADMIN_OWNER_REQUIRED' }
    if (-not [McpCcReloadNative]::OutsideAllJobs()) { throw 'INDEPENDENT_OWNER_REQUIRED' }
    $self=Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction Stop
    $tray=Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\tray.ps1'
    if ($self.Name -notin @('powershell.exe','pwsh.exe') -or $self.CommandLine -notlike "*$tray*") { throw 'TRAY_OWNER_REQUIRED' }
    # Walk the complete available ancestor chain, not just the direct parent.
    $parent=[int]$self.ParentProcessId; $seen=@{}; $depth=0
    while ($parent -gt 0) {
        if ($seen.ContainsKey($parent) -or ++$depth -gt 64) { throw 'OWNER_LINEAGE_UNKNOWN' }
        $seen[$parent]=$true
        $p=Get-CimInstance Win32_Process -Filter "ProcessId=$parent" -ErrorAction Stop
        if ($null -eq $p) { throw 'OWNER_LINEAGE_UNKNOWN' }
        if ($p.Name -match '^(node|codex|codex-exec)\.exe$' -or $p.CommandLine -match 'codex_bridge|app-server') { throw 'INDEPENDENT_OWNER_REQUIRED' }
        if ($p.Name -eq 'explorer.exe') { break }
        $parent=[int]$p.ParentProcessId
    }
    Assert-R1ProtectedPath $RuntimeRoot $owner -Private
    Assert-R1ProtectedPath $root $owner -Private
    Assert-R1ProtectedPath $policyPath $owner -Private
    if ((Get-Item -LiteralPath $policyPath).Length -gt 8192) { throw 'POLICY_INVALID' }
    $policy=Get-Content -LiteralPath $policyPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-R1Fields $policy @('contract','bridgeSid','rpId','origin','topOrigin','credentialId','x','y')
    # Existing component lifecycle starts the replacement under this same non-admin identity.
    # Same SID is not a hostile-user boundary: code ACL + sandbox-denied state + signed approval are mandatory.
    if ($policy.contract -cne 'remote-self-reload-r1' -or $policy.bridgeSid -cne $owner) { throw 'RUNTIME_IDENTITY_MISMATCH' }
    Assert-R1String $policy.bridgeSid '\AS-1-5-21-\d+-\d+-\d+-\d+\z'
    Assert-R1String $policy.rpId '\A[a-z0-9.-]{1,253}\z'
    foreach ($name in @('origin','topOrigin')) {
        $uri=[Uri]$policy.$name
        if ($uri.Scheme -cne 'https' -or $uri.AbsolutePath -cne '/' -or $uri.Query -or $uri.Fragment -or $uri.UserInfo -or
            $policy.$name -cne $uri.GetLeftPart([UriPartial]::Authority)) { throw 'POLICY_INVALID' }
    }
    $origin=[Uri]$policy.origin
    if ($origin.DnsSafeHost -cne $policy.rpId -and -not $origin.DnsSafeHost.EndsWith('.'+$policy.rpId)) { throw 'POLICY_INVALID' }
    foreach ($name in @('credentialId','x','y')) { [void][McpCcReloadNative]::Decode($policy.$name) }
    if ([McpCcReloadNative]::Decode($policy.x).Length -ne 32 -or [McpCcReloadNative]::Decode($policy.y).Length -ne 32) { throw 'POLICY_INVALID' }
    $component=Get-McpCcComponent -Manifest $Manifest -Id codex_bridge
    if ($component.runtimeMode -ne 'component-controller') { throw 'CONTROLLER_REQUIRED' }
    # A writable source checkout is never a deployed grant authority. Protect code and parents;
    # component-owned .tmp/settings/data remain outside this source traversal.
    $cc=Split-Path -Parent $PSScriptRoot
    foreach ($path in @($cc,$component.resolvedRoot,$Manifest.workspaceRoot,$Manifest.sourcePath)) { Assert-R1ProtectedPath $path $owner }
    foreach ($dir in @((Join-Path $cc 'src'),(Join-Path $cc 'scripts'),(Join-Path $cc 'config'),
        (Join-Path $component.resolvedRoot 'scripts'),(Join-Path $component.resolvedRoot 'dist'),
        (Join-Path $component.resolvedRoot 'web'),(Join-Path $component.resolvedRoot 'control-center'),
        (Join-Path $component.resolvedRoot 'node_modules'))) {
        Assert-McpCcProtectedCodeTree $dir
    }
    Assert-R1ProtectedPath (Join-Path $component.resolvedRoot 'package.json') $owner
    Assert-R1ProtectedPath (Join-Path $component.resolvedRoot 'package-lock.json') $owner
    # Legacy controller resolves executables from settings/sidecars/PATH and reads shared
    # Project Reading code. Protected CC/Bridge directories alone cannot establish closure.
    # No dispatch until installed bindings remove every mutable code selector.
    foreach ($dependency in @((Join-Path $Manifest.workspaceRoot 'project_reading\vendor\tunnel-client\tunnel-client.exe'),
        (Join-Path $Manifest.workspaceRoot 'project_reading\scripts\key-store.ps1'))) {
        Assert-R1ProtectedPath $dependency $owner
    }
    foreach ($file in Get-ChildItem -LiteralPath $root -Force) { Assert-R1ProtectedPath $file.FullName $owner -Private }
    throw 'R1_DEPENDENCY_BINDINGS_UNVERIFIED'
}
function Read-R1Http([string]$Url, [switch]$Text) {
    # Internal fixed URLs only. Never passed through MCP input.
    $response=Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3 -MaximumRedirection 0
    if ($response.StatusCode -ne 200 -or $response.RawContentLength -gt 65536) { throw 'PROBE_FAILED' }
    if ($Text) { return $response.Content.Trim() }
    return $response.Content | ConvertFrom-Json
}
function Get-R1RuntimeSnapshot($Manifest, [string]$RuntimeRoot) {
    $component=Get-McpCcComponent -Manifest $Manifest -Id codex_bridge
    $capture=& (Get-Module McpControlCenter.Core) {
        param($c,$root)
        Invoke-McpCcBoundedPowerShell -ScriptPath $c.resolvedContractScript -Arguments @('-Action','Status') `
            -WorkingDirectory $c.resolvedRoot -RuntimeRoot $root -TimeoutSeconds 30 -MaxCapturedOutputBytes 65536
    } $component $RuntimeRoot
    if ($capture.exitCode -ne 0) { throw 'OWNER_UNKNOWN' }
    $controller=$capture.stdout | ConvertFrom-Json
    if ($controller.ok -cne $true -or $controller.action -cne 'Status' -or
        $controller.after.server.ownership -cne 'OwnedReady' -or $controller.after.tunnel.ownership -cne 'OwnedReady' -or
        $controller.after.server.pid -ne $controller.after.server.listenerPid -or $controller.after.tunnelIdentity.status -cne 'Ready') { throw 'OWNER_UNKNOWN' }
    $h=Read-R1Http 'http://127.0.0.1:18828/health'
    if ($h.ok -cne $true -or $h.service -cne 'codex-handoff-bridge' -or $h.pid -ne $controller.after.server.pid -or
        $h.selfReload.contract -cne 'remote-self-reload-r1') { throw 'OWNER_UNKNOWN' }
    $drain=$h.selfReload.drain
    return [pscustomobject]@{oldPid=$h.pid; oldBuildId=$h.buildId; targetBuildId=$controller.after.canonicalBuildId;
        active=$h.jobs.active; awaitingApproval=$h.jobs.awaitingApproval; scope=$h.jobs.scope; controller=$h.controller;
        drainRequestId=$(if ($null -ne $drain) {$drain.requestId} else {''});
        drainExpiresAt=$(if ($null -ne $drain) {$drain.expiresAt} else {''}); ownerVerified=$true}
}
function Test-R1ToolSchema {
    # Fresh MCP session, discovery only. CC never reads a bearer secret or invokes a domain tool.
    $headers=@{Accept='application/json, text/event-stream'}; $session=$null
    try {
        $init=@{jsonrpc='2.0';id=1;method='initialize';params=@{protocolVersion='2025-03-26';capabilities=@{};clientInfo=@{name='mcpcc-self-reload-check';version='1'}}}|ConvertTo-Json -Depth 8 -Compress
        $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:18828/mcp' -Method Post -Headers $headers -ContentType 'application/json' -Body $init -TimeoutSec 5 -MaximumRedirection 0
        $session=$r.Headers['Mcp-Session-Id']; if (-not $session) { throw 'SCHEMA_UNVERIFIED' }
        $headers['Mcp-Session-Id']=$session
        $null=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:18828/mcp' -Method Post -Headers $headers -ContentType 'application/json' -Body '{"jsonrpc":"2.0","method":"notifications/initialized"}' -TimeoutSec 5 -MaximumRedirection 0
        $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:18828/mcp' -Method Post -Headers $headers -ContentType 'application/json' -Body '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' -TimeoutSec 5 -MaximumRedirection 0
        if ($r.RawContentLength -gt 262144) { throw 'SCHEMA_UNVERIFIED' }
        $body=[string]$r.Content
        if ($body.TrimStart().StartsWith('event:') -or $body.TrimStart().StartsWith('data:')) {
            $data=@($body -split '\r?\n' | Where-Object { $_.StartsWith('data: ') })
            if ($data.Count -ne 1) { throw 'SCHEMA_UNVERIFIED' }; $body=$data[0].Substring(6)
        }
        $json=$body|ConvertFrom-Json; if ($json.id -ne 2 -or $null -eq $json.result) { throw 'SCHEMA_UNVERIFIED' }
        $tools=@($json.result.tools); $expected=@('status','preview','request','receipt','challenge','approve')
        foreach ($op in $expected) {
            $tool=@($tools|Where-Object {$_.name -ceq "codex_self_reload_$op"})
            if ($tool.Count -ne 1 -or $tool[0].inputSchema.additionalProperties -cne $false) { throw 'SCHEMA_UNVERIFIED' }
            if ($op -in @('approve','challenge') -and (@($tool[0]._meta.ui.visibility) -join ',') -cne 'app') { throw 'SCHEMA_UNVERIFIED' }
            if ($op -in @('approve','request') -and $tool[0].annotations.readOnlyHint -cne $false) { throw 'SCHEMA_UNVERIFIED' }
        }
        return [pscustomobject]@{verified=$true; contract='remote-self-reload-r1'; toolCount=$tools.Count; schemaSha256=Get-R1Digest $json.result; hostCacheVerified=$false}
    } catch {
        $status=$null
        if ($null -ne $_.Exception.PSObject.Properties['Response'] -and $null -ne $_.Exception.Response) { $status=[int]$_.Exception.Response.StatusCode }
        return [pscustomobject]@{verified=$false; contract='remote-self-reload-r1';
            code=$(if ($status -in @(401,403)) {'AUTHENTICATED_CONNECTOR_REQUIRED'} else {'SCHEMA_UNVERIFIED'}); hostCacheVerified=$false}
    } finally {
        if ($session) { try { $null=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:18828/mcp' -Method Delete -Headers $headers -TimeoutSec 2 } catch {} }
    }
}
function Invoke-R1OwnerLoop([string]$ManifestPath,[string]$RuntimeRoot,$ShutdownSignal = $null) {
    $manifest=Read-McpCcManifest -Path $ManifestPath
    $deployment=Get-R1Deployment $RuntimeRoot $manifest
    $mutex=New-Object Threading.Mutex($false,'Local\McpCc.CodexBridge.SelfReload.R1'); $held=$false
    try {
        try { $held=$mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $held=$true }
        if (-not $held) { throw 'OWNER_BUSY' }
        $ownerModule=$ExecutionContext.SessionState.Module
        $snapshot={ & $ownerModule { param($manifest,$RuntimeRoot) Get-R1RuntimeSnapshot $manifest $RuntimeRoot } $manifest $RuntimeRoot }.GetNewClosure()
        $execute={ param($receipt)
            & $ownerModule { param($manifest,$RuntimeRoot,$receipt)
            # Re-read owner, health, build and fence immediately before the existing fixed action.
            $s=Get-R1RuntimeSnapshot $manifest $RuntimeRoot; Assert-R1Snapshot $s
            if ($s.oldPid -ne $receipt.oldPid -or $s.oldBuildId -cne $receipt.oldBuildId -or $s.targetBuildId -cne $receipt.targetBuildId -or
                $s.active -ne 0 -or $s.awaitingApproval -ne 0 -or $s.controller -notin @('idle','ready') -or $s.drainRequestId -cne $receipt.requestId -or
                $s.drainExpiresAt -cne $receipt.expiresAt -or [DateTime]::UtcNow -ge [DateTime]::Parse($receipt.expiresAt).ToUniversalTime()) { throw 'IDENTITY_CHANGED' }
            Invoke-McpCcComponentAction -Manifest $manifest -ComponentId 'codex_bridge' -Action 'reload_runtime' -RuntimeRoot $RuntimeRoot
            } $manifest $RuntimeRoot $receipt
        }.GetNewClosure()
        $postcheck={ param($receipt,$action)
            & $ownerModule { param($manifest,$RuntimeRoot,$receipt,$action)
            $s=Get-R1RuntimeSnapshot $manifest $RuntimeRoot; Assert-R1Snapshot $s
            $ready=Read-R1Http 'http://127.0.0.1:18829/readyz' -Text
            $schema=Test-R1ToolSchema
            [pscustomobject]@{ok=($action.delegated -eq $true -and $action.exitCode -eq 0 -and $s.oldPid -ne $receipt.oldPid -and
                $s.oldBuildId -ceq $receipt.targetBuildId -and $s.targetBuildId -ceq $receipt.targetBuildId -and $ready -cin @('ok','ready'));
                oldPid=$receipt.oldPid; newPid=$s.oldPid; canonicalBuildId=$s.targetBuildId; healthBuildId=$s.oldBuildId;
                healthVerified=$true; tunnelReady=$ready; schema=$schema; checkedAt=[DateTime]::UtcNow.ToString('o'); remoteHostVerified=$false}
            } $manifest $RuntimeRoot $receipt $action
        }.GetNewClosure()
        $pipe=[McpCcReloadNative]::OpenPipe($deployment.ownerSid,$deployment.policy.bridgeSid)
        try {
        $engine=New-R1Engine -Root $deployment.root -Policy $deployment.policy -Snapshot $snapshot -Execute $execute -Postcheck $postcheck
        # Only observe shutdown between operations. Never cancel an accepted
        # lifecycle action, its postcheck, or receipt persistence midway through.
        while ($null -eq $ShutdownSignal -or -not $ShutdownSignal.IsCancellationRequested) {
            Invoke-R1Tick $engine
            try {
                $wait=$pipe.WaitForConnectionAsync()
                while (-not $wait.Wait(1000)) {
                    if ($null -ne $ShutdownSignal -and $ShutdownSignal.IsCancellationRequested) { return }
                    Invoke-R1Tick $engine
                }
                if ($null -ne $ShutdownSignal -and $ShutdownSignal.IsCancellationRequested) { return }
                # Read one bounded message before RunAsClient; Windows impersonation identity
                # belongs to the last message read, not merely the connection notification.
                $buffer=New-Object byte[] 16385; $count=0; $deadline=[DateTime]::UtcNow.AddSeconds(3)
                while ($count -lt $buffer.Length -and [Array]::IndexOf($buffer,[byte]10,0,$count) -lt 0) {
                    $read=$pipe.ReadAsync($buffer,$count,$buffer.Length-$count)
                    $ms=[int]($deadline-[DateTime]::UtcNow).TotalMilliseconds
                    if ($ms -le 0 -or -not $read.Wait($ms) -or $read.Result -eq 0) { throw 'INVALID_MESSAGE' }
                    $count+=$read.Result
                }
                if ($count -gt 16384 -or $buffer[$count-1] -ne 10 -or [Array]::IndexOf($buffer,[byte]10,0,$count) -ne $count-1) { throw 'INVALID_MESSAGE' }
                $peerId=[McpCcReloadNative]::ClientPid($pipe,$deployment.policy.bridgeSid)
                $peer=Get-Process -Id $peerId -ErrorAction Stop
                try {
                    $null=$peer.Handle # retain the exact process instance while servicing the message
                    $s=& $snapshot; Assert-R1Snapshot $s
                    # Bridge uses a fixed, short-lived IPC client helper. Authenticate both exact helper
                    # and its controller-proven parent. The helper has no lifecycle/approval authority.
                    $peerCim=Get-CimInstance Win32_Process -Filter "ProcessId=$peerId" -ErrorAction Stop
                    $helper=Join-Path $deployment.component.resolvedRoot 'scripts\self-reload-pipe-client.ps1'
                    if ($peer.HasExited -or [int]$peerCim.ParentProcessId -ne $s.oldPid -or
                        $peer.Path -ine (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -or
                        $peerCim.CommandLine -notmatch ('-File\s+"?'+[regex]::Escape($helper)+'"?\s*$')) { throw 'IPC_UNAUTHORIZED' }
                    $message=(New-Object Text.UTF8Encoding($false,$true)).GetString($buffer,0,$count)|ConvertFrom-Json
                    if ($peer.HasExited) { throw 'IPC_UNAUTHORIZED' }
                    try { $result=Invoke-R1Message $engine $message; $response=@{contract='remote-self-reload-r1';ok=$true;result=$result} }
                    catch { $response=@{contract='remote-self-reload-r1';ok=$false;code=(Get-R1SafeCode $_)} }
                    $bytes=[Text.Encoding]::UTF8.GetBytes(($response|ConvertTo-Json -Depth 25 -Compress)+"`n")
                    if ($bytes.Length -gt 32768) { throw 'STORE_LIMIT' }
                    $write=$pipe.WriteAsync($bytes,0,$bytes.Length); if (-not $write.Wait(3000)) { throw 'IPC_TIMEOUT' }
                } finally { $peer.Dispose() }
            } catch { # A malformed or dead peer cannot stop the owner or launch an action.
                if ($engine.PSObject.Properties['poisoned'] -and $engine.poisoned) { throw }
            } finally { if ($pipe.IsConnected) { $pipe.Disconnect() } }
        } } finally { $pipe.Dispose() }
    } finally { if ($held) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
}
Export-ModuleMember -Function Get-R1Deployment,Invoke-R1OwnerLoop,Get-R1RuntimeSnapshot,Test-R1ToolSchema,Assert-R1ProtectedPath
