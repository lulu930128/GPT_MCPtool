param([string]$Case='All',[string]$FixtureRoot)
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1 -or $PSVersionTable.PSEdition -ne 'Desktop') { throw 'EXPECTED_WINDOWS_POWERSHELL_5_1' }
$root=Split-Path -Parent $PSScriptRoot
$tokens=$null;$errors=$null
if ($Case -eq 'All') {
    $FixtureRoot=Join-Path $root ('.tmp\workspace-native-'+[guid]::NewGuid().ToString('N'))
    $cc=Join-Path $FixtureRoot 'build';$bridge=Join-Path $FixtureRoot 'unused'
    [void][IO.Directory]::CreateDirectory((Join-Path $cc 'src'))
    Copy-Item -LiteralPath (Join-Path $root 'src\WorkspaceLocal.Native.cs') -Destination (Join-Path $cc 'src')
    # Execute only the real Prepare compiler configuration and loop, never Prepare.
    $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $root '..\codex_bridge\scripts\installed-release-operator.ps1'),[ref]$tokens,[ref]$errors)
    if ($errors.Count) { throw 'OPERATOR_SYNTAX_INVALID' }
    foreach ($name in @('framework','nativeBuilds')) {
        $nodes=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left -is [Management.Automation.Language.VariableExpressionAst] -and $n.Left.VariablePath.UserPath -ceq $name},$true))
        if ($nodes.Count -ne 1) { throw 'COMPILER_ASSIGNMENT_NOT_UNIQUE' }
        . ([scriptblock]::Create($nodes[0].Extent.Text))
    }
    $nativeBuilds=@($nativeBuilds | Where-Object {(Split-Path -Leaf $_.output) -ceq 'WorkspaceLocal.Native.dll'})
    if ($nativeBuilds.Count -ne 1) { throw 'WORKSPACE_BUILD_MISSING' }
    $loop=$ast.Find({param($n) $n -is [Management.Automation.Language.ForEachStatementAst] -and $n.Variable.VariablePath.UserPath -ceq 'native'},$true)
    $verifier=Import-Module (Join-Path $root 'src\McpControlCenter.InstalledRelease.psm1') -PassThru
    & ([scriptblock]::Create($loop.Extent.Text))
    $nativeBuilds[0].output=Join-Path $cc 'src\Wrong.Native.dll'
    & ([scriptblock]::Create($loop.Extent.Text))
    $cases=@('v3','v4','missing','foreign','sourceLoaded','wrongName','oldRelease','wrongRoot','invalidRegistry','downgrade')
    foreach ($testCase in $cases) {
        & (Join-Path $PSHOME 'powershell.exe') -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -Case $testCase -FixtureRoot $FixtureRoot
        if ($LASTEXITCODE -ne 0) { throw ('LOADER_CASE_FAILED: '+$testCase) }
    }
    # Run only the tray's owner-init block with a fake constructor. No tray,
    # production mutex/pipe, controller, process inspection or lifecycle launch.
    $tray=[Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'scripts\tray.ps1'),[ref]$tokens,[ref]$errors)
    if ($errors.Count) { throw 'TRAY_SYNTAX_INVALID' }
    $block=$tray.Find({param($n) $n -is [Management.Automation.Language.IfStatementAst] -and $n.Extent.Text.Contains('$script:WorkspaceLocalOwner = New-McpCcWorkspaceLocalOwner')},$true)
    $text=$tray.Extent.Text
    $activationCalls=@($tray.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Assert-McpCcInstalledActivation'},$true))
    if ($activationCalls.Count -ne 1 -or $text.IndexOf('Assert-McpCcInstalledActivation $manifest -TrayBootstrap') -gt $block.Extent.StartOffset -or
        $text.IndexOf('"Local\McpControlCenterTray"') -gt $block.Extent.StartOffset) { throw 'TRAY_ORDER_INVALID' }
    $loader=[Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'src\McpControlCenter.WorkspaceLocal.psm1'),[ref]$tokens,[ref]$errors)
    if ($errors.Count -or @($loader.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst] -and
        $n.GetCommandName() -in @('Assert-McpCcInstalledClosure','Assert-McpCcInstalledActivation','Import-Module')},$true)).Count) { throw 'DUPLICATE_LOADER_GATE' }
    & {
        function Import-Module {param($Name)}
        function New-McpCcWorkspaceLocalOwner {param($RuntimeRoot,$Manifest) if ($Manifest.schemaVersion -notin @(3,4)) {throw 'WRONG_VERSION'};return $Manifest.schemaVersion}
        $projectRoot=$root;$RuntimeRoot=$FixtureRoot
        foreach ($version in @(3,4)) {
            $manifest=[pscustomobject]@{schemaVersion=$version};$script:WorkspaceLocalOwner=$null
            & ([scriptblock]::Create($block.Extent.Text))
            if ($script:WorkspaceLocalOwner -ne $version) { throw 'TRAY_OWNER_SKIPPED' }
        }
        function New-McpCcWorkspaceLocalOwner {throw 'WORKSPACE_LOCAL_NATIVE_MISSING'}
        $script:WorkspaceLocalOwner=$null
        $warnings=@(& ([scriptblock]::Create($block.Extent.Text)) 3>&1)
        if ($null -ne $script:WorkspaceLocalOwner -or ($warnings -join '') -notmatch 'WORKSPACE_LOCAL_NATIVE_MISSING') { throw 'TRAY_FAILURE_NOT_DIAGNOSTIC' }
        if ($script:WorkspaceLocalStartupReason -cne 'WORKSPACE_LOCAL_NATIVE_MISSING') { throw 'TRAY_FAILURE_NOT_RETAINED' }
        $display=$tray.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Get-TrayWorkspaceLocalStatusText'},$true)
        . ([scriptblock]::Create($display.Extent.Text))
        if ((Get-TrayWorkspaceLocalStatusText) -cne ('Workspace IPC: WORKSPACE_LOCAL_NATIVE_MISSING | PID {0} | registry v4' -f $PID)) { throw 'TRAY_FAILURE_NOT_VISIBLE' }
        # Hidden startup must retain only a safe code/type/HRESULT, never raw paths or payloads.
        function New-McpCcWorkspaceLocalOwner {throw [IO.IOException]::new('private-token C:\private\payload')}
        $warnings=@(& ([scriptblock]::Create($block.Extent.Text)) 3>&1)
        $message=Get-TrayWorkspaceLocalStatusText
        if ($message -notmatch 'IOException, HRESULT=0x[0-9A-F]{8}' -or ($message+($warnings -join '')) -match 'private-token|payload') { throw 'TRAY_FAILURE_NOT_SANITIZED' }
        $script:WorkspaceLocalOwner=[pscustomobject]@{Running=$true}
        if ((Get-TrayWorkspaceLocalStatusText) -notmatch 'LISTENING \(E2E unverified\)') { throw 'TRAY_LISTENER_NOT_VISIBLE' }
        $script:WorkspaceLocalOwner.Running=$false
        if ((Get-TrayWorkspaceLocalStatusText) -notmatch 'WORKSPACE_LOCAL_LISTENER_STOPPED') { throw 'TRAY_STOPPED_LISTENER_HIDDEN' }
    }
    [pscustomobject]@{ok=$true;loaderCases=$cases.Count;trayCases=3;diagnosticCases=5;protectedAcl='MOCK';activation='NOT_EXECUTED';productionPipe=$false;liveRestart=$false} | ConvertTo-Json -Compress
    exit 0
}
if ($Case -notin @('v3','v4','missing','foreign','sourceLoaded','wrongName','oldRelease','wrongRoot','invalidRegistry','downgrade') -or
    (Split-Path -Parent ([IO.Path]::GetFullPath($FixtureRoot))) -ine (Join-Path $root '.tmp') -or
    (Split-Path -Leaf $FixtureRoot) -cnotmatch '^workspace-native-[0-9a-f]{32}$') { throw 'FIXTURE_PATH_INVALID' }
$manager=Join-Path $FixtureRoot ($Case+'\mcp_control_center')
[void][IO.Directory]::CreateDirectory((Join-Path $manager 'src'))
[void][IO.Directory]::CreateDirectory((Join-Path $manager 'config'))
foreach ($name in @('McpControlCenter.WorkspaceLocal.psm1','WorkspaceLocal.Native.cs')) {
    Copy-Item -LiteralPath (Join-Path $root ('src\'+$name)) -Destination (Join-Path $manager 'src')
}
if ($Case -ne 'v3') { [IO.File]::WriteAllText((Join-Path $manager 'config\installed-release.json'),'{}') }
$native=Join-Path $manager 'src\WorkspaceLocal.Native.dll'
if ($Case -ne 'missing') {
    $file=if ($Case -eq 'wrongName') {'Wrong.Native.dll'} else {'WorkspaceLocal.Native.dll'}
    Copy-Item -LiteralPath (Join-Path $FixtureRoot ('build\src\'+$file)) -Destination $native
}
if ($Case -eq 'foreign') { Add-Type -Path (Join-Path $FixtureRoot 'build\src\WorkspaceLocal.Native.dll') }
if ($Case -eq 'sourceLoaded') { Add-Type -Path (Join-Path $manager 'src\WorkspaceLocal.Native.cs') -ReferencedAssemblies System.Web.Extensions,System.Core }
# Match the real Tray import order and verify exported-command visibility from
# the WorkspaceLocal module before replacing only the filesystem ACL boundary.
Import-Module (Join-Path $root 'src\McpControlCenter.InstalledRelease.psm1')
$module=Import-Module (Join-Path $manager 'src\McpControlCenter.WorkspaceLocal.psm1') -PassThru
if ((& $module {(Get-Command Assert-McpCcProtectedCodePath).ModuleName}) -cne 'McpControlCenter.InstalledRelease') {throw 'VERIFIER_SCOPE_UNAVAILABLE'}
& $module {
    param($SourceRoot)
    # Only the protected-path boundary is simulated. Real DLL/type loading is
    # exercised in a fresh process; no production ACL is relaxed or modified.
    $script:pathChecks=0;$script:fixtureSourceRoot=$SourceRoot
    function script:Import-Module {throw 'DUPLICATE_VERIFIER_IMPORT'}
    function script:Assert-McpCcProtectedCodePath {param($Path) if ($Path -ine (Join-Path $script:fixtureSourceRoot 'WorkspaceLocal.Native.dll')) {throw 'WRONG_NATIVE_PATH'};$script:pathChecks++}
    function script:Assert-McpCcInstalledClosure {throw 'DUPLICATE_CLOSURE_SCAN'}
    function script:Assert-McpCcInstalledActivation {throw 'DUPLICATE_ACTIVATION'}
} (Join-Path $manager 'src')
$version=if ($Case -in @('v3','downgrade')) {3} elseif ($Case -eq 'invalidRegistry') {5} else {4}
$manifest=[pscustomobject]@{schemaVersion=$version;installedRelease=[pscustomobject]@{root=(Split-Path -Parent $manager);schemaVersion=6}}
if ($Case -eq 'oldRelease') {$manifest.installedRelease.schemaVersion=2}
if ($Case -eq 'wrongRoot') {$manifest.installedRelease.root=Join-Path $FixtureRoot 'another-release'}
$expected=@{missing='WORKSPACE_LOCAL_NATIVE_MISSING';foreign='WORKSPACE_LOCAL_ASSEMBLY_SOURCE_REJECTED';sourceLoaded='WORKSPACE_LOCAL_ASSEMBLY_SOURCE_REJECTED';wrongName='WORKSPACE_LOCAL_ASSEMBLY_VERSION_REJECTED';oldRelease='INSTALLED_LIFECYCLE_BINDINGS_REQUIRED';wrongRoot='WORKSPACE_LOCAL_RELEASE_MISMATCH';invalidRegistry='WORKSPACE_LOCAL_REGISTRY_VERSION_REJECTED';downgrade='WORKSPACE_LOCAL_REGISTRY_VERSION_REJECTED'}
$failure=''
try { & $module {param($m) Initialize-McpCcWorkspaceLocalNative $m} $manifest } catch {$failure=$_.Exception.GetBaseException().Message}
if ($expected.ContainsKey($Case)) {
    if ($failure -cne $expected[$Case]) { throw ('EXPECTED '+$expected[$Case]+'; ACTUAL '+$failure) }
} else {
    if ($failure) {throw $failure}
    if ($Case -eq 'v4' -and ([McpCc.WorkspaceLocal.Owner].Assembly.Location -ine $native -or (& $module {$script:pathChecks}) -ne 1)) {throw 'INSTALLED_ORIGIN_NOT_VERIFIED'}
    if ($Case -eq 'v3' -and (& $module {$script:pathChecks}) -ne 0) {throw 'SOURCE_BEHAVIOR_CHANGED'}
}
Write-Output ($Case+': PASS')
