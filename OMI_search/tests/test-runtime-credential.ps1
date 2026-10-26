# Run in a disposable powershell.exe -NoProfile -File process. No User registry IO.
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
# Some sandbox hosts supply duplicate PATH/Path keys, rejected by .NET's
# case-insensitive child environment dictionary. Normalize only this test host.
$testPath = [Environment]::GetEnvironmentVariable('PATH', 'Process')
[Environment]::SetEnvironmentVariable('PATH', $null, 'Process')
[Environment]::SetEnvironmentVariable('Path', $null, 'Process')
[Environment]::SetEnvironmentVariable('PATH', $testPath, 'Process')
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$testRoot = Join-Path $tempBase ('omi credential test-' + [Guid]::NewGuid().ToString('N'))
$modulePath = Join-Path $projectRoot 'scripts\omi-search-runtime.psm1'
$script:Passed = 0
function Assert-Safe([bool]$Condition, [string]$Code) {
  if (-not $Condition) { throw "CREDENTIAL_FIXTURE_FAILED: $Code" }
  $script:Passed++
}

try {
  New-Item -ItemType Directory -Path $testRoot | Out-Null
  $parseErrors = $null; $tokens = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($modulePath, [ref]$tokens, [ref]$parseErrors)
  Assert-Safe ($parseErrors.Count -eq 0) 'module_parse'
  $functions = @{}
  foreach ($node in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    $functions[$node.Name] = $node
  }
  $reader = $functions['Read-OmiRuntimeControlUserToken'].Body.Extent.Text
  Assert-Safe ($reader.Contains("[Environment]::GetEnvironmentVariable('OMI_SEARCH_RUNTIME_CONTROL_TOKEN', 'User')")) 'canonical_user_source'
  Assert-Safe (-not $reader.Contains('Process') -or $reader.Contains('# Process')) 'reader_has_no_process_fallback'
  $spawn = $functions['Start-OmiChildProcess'].Body.Extent.Text
  Assert-Safe (-not $spawn.Contains('SetEnvironmentVariable')) 'no_parent_environment_mutation'
  Assert-Safe (-not $spawn.Contains('Env:')) 'no_parent_environment_provider_mutation'
  $core = $functions['Start-OmiServer'].Body.Extent.Text
  Assert-Safe ($core.Contains('-CoreContext $Context')) 'core_wiring'
  Assert-Safe ($core.Contains('Start-OmiChildProcess -StartInfo $probeInfo -Environment @{}')) 'probe_sanitized'
  Assert-Safe (-not $functions['Start-OmiTunnelOnce'].Body.Extent.Text.Contains('-CoreContext')) 'tunnel_has_no_user_reader'

  $module = Import-Module $modulePath -Force -PassThru
  # Replace the private registry boundary BEFORE any call that could spawn core.
  & $module {
    $script:FixtureMode = 'valid'
    $script:FixtureReads = 0
    function script:Read-OmiRuntimeControlUserToken {
      $script:FixtureReads++
      switch ($script:FixtureMode) {
        valid { return ('a' * 64) }
        missing { return $null }
        empty { return '' }
        uppercase { return ('A' * 64) }
        short { return ('a' * 63) }
        long { return ('a' * 65) }
        nonhex { return ('g' * 64) }
        newline { return (('a' * 64) + "`n") }
        space { return (' ' + ('a' * 64)) }
        wrong_account { throw [UnauthorizedAccessException]::new('synthetic denied ' + ('a' * 64)) }
        default { throw 'FIXTURE_MODE_INVALID' }
      }
    }
  }
  $childPath = Join-Path $testRoot 'environment-child.exe'
  $source = @'
using System;
public static class EnvironmentChild {
  public static int Main(string[] args) {
    string raw = Environment.GetEnvironmentVariable("OMI_SEARCH_RUNTIME_CONTROL_TOKEN");
    bool present = args.Length == 1 && args[0] == "core-valid";
    if (present ? raw != new string('a', 64) : raw != null) return 11;
    if (Environment.GetEnvironmentVariable("CONTROL_PLANE_API_KEY") != "fixture-control-key") return 12;
    if (Environment.GetEnvironmentVariable("OMI_SEARCH_MCP_HTTP_TOKEN") != "fixture-http-key") return 13;
    foreach (string name in new [] {"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"})
      if (Environment.GetEnvironmentVariable(name) != null) return 14;
    if (Environment.GetEnvironmentVariable("NO_PROXY") != "127.0.0.1,localhost") return 15;
    if (Environment.CommandLine.Contains(new string('a', 64)) || Environment.CommandLine.Contains(new string('b', 64))) return 16;
    if (Environment.GetEnvironmentVariable("OMI_FIXTURE_UNICODE") != new string((char)0x6f22, 1)) return 17;
    Console.WriteLine("PASS");
    return 0;
  }
}
'@
  Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $childPath -OutputType ConsoleApplication
  # Synthetic Process environment only, in this disposable test host.
  $env:OMI_SEARCH_RUNTIME_CONTROL_TOKEN = 'b' * 64
  $env:CONTROL_PLANE_API_KEY = 'fixture-control-key'
  $env:OMI_SEARCH_MCP_HTTP_TOKEN = 'fixture-http-key'
  $env:HTTP_PROXY = 'http://fixture.invalid:1'
  $env:HTTPS_PROXY = 'http://fixture.invalid:2'
  $env:ALL_PROXY = 'http://fixture.invalid:3'
  $env:NO_PROXY = 'fixture.invalid'
  $env:OMI_FIXTURE_UNICODE = [string][char]0x6f22
  foreach ($detached in @($false, $true)) {
  foreach ($mode in @('valid', 'missing', 'empty', 'uppercase', 'short', 'long', 'nonhex', 'newline', 'space', 'wrong_account', 'tunnel', 'probe')) {
    & $module { param($mode) $script:FixtureMode = $mode; $script:FixtureReads = 0 } $mode
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $childPath
    $info.Arguments = $(if ($mode -eq 'valid') { 'core-valid' } else { 'no-auth' })
    $info.WorkingDirectory = $testRoot
    $info.RedirectStandardOutput = -not $detached
    $info.RedirectStandardError = -not $detached
    $context = if ($mode -in @('tunnel', 'probe')) { $null } else { @{ runtimeDir = $testRoot } }
    $process = & $module {
      param($info, $context, $detached)
      # Even an accidental generic override cannot grant tunnel/probe authority.
      Start-OmiChildProcess -StartInfo $info -Environment @{ OMI_SEARCH_RUNTIME_CONTROL_TOKEN = ('c' * 64) } -CoreContext $context -Detached:$detached
    } $info $context $detached
    try {
      Assert-Safe ($process.WaitForExit(5000)) 'child_exit_bounded'
      Assert-Safe ($process.ExitCode -eq 0) ('child_environment_' + $mode)
      if (-not $detached) {
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        Assert-Safe ($stdout.Trim() -eq 'PASS' -and $stderr.Length -eq 0) 'child_output_redacted'
      }
    }
    finally { $process.Dispose() }
    Assert-Safe ($info.UseShellExecute -eq $false -and $info.CreateNoWindow) 'isolated_hidden_spawn'
    Assert-Safe (-not $info.EnvironmentVariables.ContainsKey('OMI_SEARCH_RUNTIME_CONTROL_TOKEN')) 'startinfo_secret_released'
    Assert-Safe ($info.Arguments -in @('core-valid', 'no-auth')) 'commandline_no_credential'
    Assert-Safe ($env:OMI_SEARCH_RUNTIME_CONTROL_TOKEN -ceq ('b' * 64)) 'parent_token_unchanged'
    Assert-Safe ($env:HTTP_PROXY -eq 'http://fixture.invalid:1' -and $env:NO_PROXY -eq 'fixture.invalid') 'parent_proxy_unchanged'
    $reads = & $module { $script:FixtureReads }
    Assert-Safe ($reads -eq $(if ($null -eq $context) { 0 } else { 1 })) 'user_read_core_only'
    if ($null -ne $context) {
      $diagnostic = [IO.File]::ReadAllText((Join-Path $testRoot 'runtime-control-auth.log'))
      Assert-Safe ($diagnostic -ceq $(if ($mode -eq 'valid') { 'RUNTIME_CONTROL_AUTH_USER_VALID' } else { 'RUNTIME_CONTROL_AUTH_USER_UNAVAILABLE' })) 'bounded_local_diagnostic'
    }
  }
  }
  # A spawn failure also releases the secret and cannot change parent env.
  & $module { $script:FixtureMode = 'valid' }
  foreach ($detached in @($false, $true)) {
  $badInfo = New-Object Diagnostics.ProcessStartInfo
  $badInfo.FileName = Join-Path $testRoot 'absent.exe'
  $badInfo.WorkingDirectory = $testRoot
  $failed = $false
  try { $null = & $module { param($info, $root, $detached) Start-OmiChildProcess -StartInfo $info -Environment @{} -CoreContext @{ runtimeDir = $root } -Detached:$detached } $badInfo $testRoot $detached }
  catch { $failed = $true; Assert-Safe (-not $_.Exception.Message.Contains(('a' * 64))) 'spawn_exception_redacted' }
  Assert-Safe $failed 'spawn_failure_observed'
  Assert-Safe (-not $badInfo.EnvironmentVariables.ContainsKey('OMI_SEARCH_RUNTIME_CONTROL_TOKEN')) 'failed_startinfo_released'
  Assert-Safe ($env:OMI_SEARCH_RUNTIME_CONTROL_TOKEN -ceq ('b' * 64)) 'failed_spawn_parent_unchanged'
  }
  # Diagnostic write failure cannot turn a valid Core spawn into market outage.
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $childPath; $info.Arguments = 'core-valid'; $info.WorkingDirectory = $testRoot
  $process = & $module { param($info, $file) Start-OmiChildProcess -StartInfo $info -Environment @{} -CoreContext @{ runtimeDir = $file } -Detached } $info $childPath
  try { Assert-Safe ($process.WaitForExit(5000) -and $process.ExitCode -eq 0) 'diagnostic_failure_does_not_block_core' }
  finally { $process.Dispose() }
  [pscustomobject]@{ ok = $true; assertions = $script:Passed; userRegistryAccess = $false; actualChildProcesses = 25 } | ConvertTo-Json -Compress
}
finally {
  $resolved = [IO.Path]::GetFullPath($testRoot)
  if ($resolved.StartsWith($tempBase + '\', [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolved)) {
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
