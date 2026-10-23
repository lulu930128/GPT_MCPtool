# Fixed authenticated IPC client only. This Bridge child never performs lifecycle work.
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$contract='remote-self-reload-r1'
$pipe=$null; $peer=$null
try {
    $workspace=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    # Physical sibling only. An installed candidate cannot fall through to a dev owner
    # or load native code before the unfinished installed activation gate.
    $config=Join-Path $workspace 'mcp_control_center\config'
    $registry=Join-Path $config 'registry.json'
    if ((Test-Path -LiteralPath (Join-Path $config 'installed-release.json')) -or
        ((Test-Path -LiteralPath $registry -PathType Leaf) -and
         (Get-Content -LiteralPath $registry -Raw -Encoding UTF8 | ConvertFrom-Json).schemaVersion -eq 4)) {
        $module=Import-Module (Join-Path $PSScriptRoot 'codex-bridge-runtime.psm1') -PassThru
        & $module {$b=Get-CbInstalledBinding;Assert-McpCcInstalledSelection $b}
        # G0 remains closed independently of local G2 activation.
        throw 'HOST_NOT_VERIFIED'
    }
    Add-Type -Path (Join-Path $workspace 'mcp_control_center\src\RemoteSelfReload.Native.cs')
    $inputStream=[Console]::OpenStandardInput();$buffer=New-Object byte[] 16385;$count=0
    while ($count -lt $buffer.Length) { $n=$inputStream.Read($buffer,$count,$buffer.Length-$count);if ($n -eq 0) {break};$count+=$n }
    if ($count -eq 0 -or $count -gt 16384 -or $buffer[$count-1] -ne 10) { throw 'MESSAGE_LIMIT' }
    $pipe=New-Object IO.Pipes.NamedPipeClientStream('.', 'McpCc.CodexBridge.Reload.R1',[IO.Pipes.PipeDirection]::InOut,
        [IO.Pipes.PipeOptions]::Asynchronous,[Security.Principal.TokenImpersonationLevel]::Identification)
    $pipe.Connect(1500)
    $peerId=[McpCcReloadNative]::ServerPid($pipe);$peer=Get-Process -Id $peerId -ErrorAction Stop;$null=$peer.Handle
    $process=Get-CimInstance Win32_Process -Filter "ProcessId=$peerId" -ErrorAction Stop
    $sid=Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop
    $tray=Join-Path $workspace 'mcp_control_center\scripts\tray.ps1'
    if ($peer.HasExited -or -not [McpCcReloadNative]::OutsideJobs($peer) -or $sid.ReturnValue -ne 0 -or
        $sid.Sid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or
        $peer.Path -ine (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -or
        $process.CommandLine -notmatch ('-File\s+"?'+[regex]::Escape($tray)+'"?(\s|$)') -or $process.CommandLine -match '-Command\b|-EncodedCommand\b') { throw 'IPC_UNAUTHORIZED' }
    $write=$pipe.WriteAsync($buffer,0,$count);if (-not $write.Wait(3000)) {throw 'OWNER_UNAVAILABLE'}
    $output=New-Object byte[] 32769;$length=0;$deadline=[DateTime]::UtcNow.AddSeconds(6)
    while ($length -lt $output.Length -and [Array]::IndexOf($output,[byte]10,0,$length) -lt 0) {
        $read=$pipe.ReadAsync($output,$length,$output.Length-$length);$ms=[int]($deadline-[DateTime]::UtcNow).TotalMilliseconds
        if ($ms -le 0 -or -not $read.Wait($ms) -or $read.Result -eq 0) {throw 'OWNER_UNAVAILABLE'};$length+=$read.Result
    }
    if ($length -gt 32768 -or $output[$length-1] -ne 10 -or $peer.HasExited) {throw 'INVALID_OWNER_RESPONSE'}
    [Console]::OpenStandardOutput().Write($output,0,$length)
} catch {
    [Console]::WriteLine('{"contract":"remote-self-reload-r1","ok":false,"code":"OWNER_UNAVAILABLE"}')
    exit 1
} finally {if ($pipe) {$pipe.Dispose()};if ($peer) {$peer.Dispose()}}
