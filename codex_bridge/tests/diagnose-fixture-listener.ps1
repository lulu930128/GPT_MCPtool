param([Parameter(Mandatory=$true)][int]$Port,[Parameter(Mandatory=$true)][string]$ModulePath)
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$module=Import-Module $ModulePath -PassThru -Force
$observed=& $module {param($p) Get-CbListenerState -Port $p} $Port
$native='C:\Windows\System32\netstat.exe';$nativeError=$null;$nativeExit=$null;$matched=@()
try {
  $lines=@(& $native -ano -p tcp 2>$null)
  $matched=@($lines|Where-Object{$_ -match ('^\s*TCP\s+\S+:'+$Port+'\s+.*LISTENING\s+\d+\s*$')})
  $nativeExit=$LASTEXITCODE
}catch{$nativeError=[pscustomobject]@{type=$_.Exception.GetType().FullName;message=$_.Exception.Message;id=$_.FullyQualifiedErrorId}}
[pscustomobject]@{port=$Port;listener=$observed;nativeExit=$nativeExit;matched=$matched;nativeError=$nativeError;
  cwd=$PWD.Path;windir=$env:WINDIR;systemRoot=$env:SystemRoot;pathPresent=(-not[string]::IsNullOrWhiteSpace($env:PATH));
  comspecPresent=(-not[string]::IsNullOrWhiteSpace($env:ComSpec));pathExt=$env:PATHEXT;psModulePath=$env:PSModulePath}|ConvertTo-Json -Depth 5
