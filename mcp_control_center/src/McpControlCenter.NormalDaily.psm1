Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
# Daily NORMAL has two independently selected code roots. It never manufactures
# an InstalledRelease binding or changes the Bridge launcher/environment.
$script:NormalDeployment=Import-Module (Join-Path $PSScriptRoot 'McpControlCenter.Deployment.psm1') -PassThru
$script:NormalDaily=Import-Module (Join-Path $PSScriptRoot 'McpControlCenter.DailyCode.psm1') -PassThru

function Read-McpCcNormalDailyBridge($Layout) {
    $bridge=Get-McpCcBridgeDeployment $Layout.workspaceRoot
    $runtime=Join-Path $Layout.workspaceRoot 'codex_bridge\Runtime'
    $manifestPath=Join-Path (Split-Path -Parent $bridge.root) 'daily-release.json'
    $manifest=& $script:NormalDaily { param($r,$v) Test-DailyVersion $r $v } $runtime $bridge.version
    . (Join-Path $bridge.root 'scripts\daily-runtime-settings.ps1')
    $settings=Read-CbDailySettings (Split-Path -Parent $bridge.root)
    $again=Get-McpCcBridgeDeployment $Layout.workspaceRoot
    if($again.root -ine $bridge.root){throw 'DAILY_NORMAL_SELECTION_CHANGED'}
    return [pscustomobject]@{root=$bridge.root;version=$bridge.version;manifestPath=$manifestPath;
        pin=(Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash;
        nodePath=$settings.nodePath;operatorSid=$settings.operatorSid}
}

function Open-McpCcNormalDailyContext([string]$ManagerRoot,[int]$TrayProcessId) {
    if([IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)) -ine $ManagerRoot){throw 'SOURCE_ROOT_MISMATCH'}
    $layout=Get-McpCcDeploymentLayout $ManagerRoot
    if($null -eq $layout){throw 'NORMAL_DEPLOYMENT_MISSING'}
    $manifestPath=Join-Path $ManagerRoot 'code-inventory.json'
    $nativePath=Join-Path $ManagerRoot 'src\NormalOperator.Host.dll'
    if(-not(Test-Path -LiteralPath $nativePath -PathType Leaf)){throw 'NORMAL_HOST_BINARY_MISSING'}
    Assert-McpCcDeploymentSelected $layout
    if(-not ('McpCcNormalHost' -as [type])){Add-Type -Path $nativePath}
    foreach($name in @('McpCcNormalNative','McpCcNormalPipe','McpCcNormalSecurity','McpCcNormalExecution','McpCcNormalHost')){
        $type=$name -as [type]
        if($null -eq $type -or $type.Assembly.Location -ine $nativePath){throw 'NORMAL_LOADED_SOURCE_REJECTED'}
    }
    $process=Get-Process -Id $TrayProcessId -ErrorAction Stop
    try {
        $proof=[McpCcNormalNative]::Inspect($process)
        $token=[McpCcNormalSecurity]::Observe($process)
        $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        [McpCcNormalSecurity]::AssertNormal($token,$sid,$proof.session)
        if($proof.inAnyJob){throw 'OWNER_IN_JOB'}
        $image='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
        $tray=Join-Path $ManagerRoot 'scripts\tray.ps1'
        $pattern='(?i)^"?'+[regex]::Escape($image)+'"?\s+-NoProfile\s+(?:-WindowStyle\s+Hidden\s+)?-File\s+"'+[regex]::Escape($tray)+'"(?:\s+-AutoReconcile)?\s*$'
        $cim=Get-CimInstance Win32_Process -Filter "ProcessId=$TrayProcessId" -ErrorAction Stop
        if($proof.image -ine $image -or $null -eq $cim -or $cim.CommandLine -inotmatch $pattern){throw 'EXACT_TRAY_OWNER_REQUIRED'}
        [McpCcNormalSecurity]::AssertUnchanged($process,$token)
        $peer=[McpCcNormalPipe+Peer]::Retain($proof.pid,$proof.sid,$proof.image,$proof.session,$proof.startedUtcTicks,$true)
        return [pscustomobject]@{mode='daily';layout=$layout;manifestPath=$manifestPath;
            pin=(Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash;operatorSid=$sid;
            bridge=$null;peer=$peer;channel=[McpCcNormalPipe]::OwnerChannel($proof);proof=$proof;sessionCheckedAt=$null}
    } finally {$process.Dispose()}
}

function Assert-McpCcNormalDailyBinding($Context) {
    & $script:NormalDeployment {param($p) Assert-CcDeploymentPath $p} $Context.manifestPath
    if((Get-FileHash -LiteralPath $Context.manifestPath -Algorithm SHA256).Hash -cne $Context.pin){throw 'DAILY_NORMAL_CLOSURE_CHANGED'}
    $selector=& $script:NormalDeployment {param($p) Read-CcDeploymentJson $p} (Join-Path $Context.layout.runtimeRoot 'current.json')
    if($selector.contract -cne 'mcpcc-current-v1' -or $selector.version -cne $Context.layout.version){throw 'CC_SELECTION_CHANGED'}
    if($null -ne $Context.bridge){
        $selected=Get-McpCcBridgeDeployment $Context.layout.workspaceRoot
        if($selected.root -ine $Context.bridge.root -or
            (Get-FileHash -LiteralPath $Context.bridge.manifestPath -Algorithm SHA256).Hash -cne $Context.bridge.pin){throw 'DAILY_NORMAL_SELECTION_CHANGED'}
    }
    $Context.peer.Check()
}

function Assert-McpCcNormalDailyClosure($Context) {
    # Resolve Bridge on every session, then retain this exact generation until
    # that session ends. CC does not restart when Bridge changes selection.
    $Context.bridge=$null
    Assert-McpCcNormalDailyBinding $Context
    Assert-McpCcDeploymentSelected $Context.layout
    $Context.bridge=Read-McpCcNormalDailyBridge $Context.layout
    if($Context.bridge.operatorSid -cne $Context.operatorSid){throw 'DAILY_NORMAL_OPERATOR_MISMATCH'}
    Assert-McpCcNormalDailyBinding $Context
}
Export-ModuleMember -Function Open-McpCcNormalDailyContext,Assert-McpCcNormalDailyBinding,Assert-McpCcNormalDailyClosure
