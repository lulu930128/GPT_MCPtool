param(
  [string]$ProjectRoot,
  [string]$ShortcutName = "GPT Workspace MCP.lnk"
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

$launcher = Join-Path $ProjectRoot "scripts\start-tray.vbs"
if (-not (Test-Path -LiteralPath $launcher)) {
  throw "Missing launcher: $launcher"
}

$startupDir = [Environment]::GetFolderPath("Startup")
if ([string]::IsNullOrWhiteSpace($startupDir)) {
  throw "Could not resolve the current user's Startup folder."
}

$shortcutPath = Join-Path $startupDir $ShortcutName
$wscript = Join-Path $env:WINDIR "System32\wscript.exe"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $wscript
$shortcut.Arguments = "`"$launcher`""
$shortcut.WorkingDirectory = $ProjectRoot
$shortcut.WindowStyle = 7
$shortcut.Description = "Start GPT Workspace MCP tray and Secure MCP Tunnel"
$shortcut.Save()

[pscustomobject]@{
  installed = $true
  shortcutPath = $shortcutPath
  target = $launcher
  autoStartsTunnel = $true
} | ConvertTo-Json -Depth 4
