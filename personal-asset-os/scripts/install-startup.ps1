Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$Launcher = Join-Path $ProjectRoot "scripts\start-tray.vbs"
$Startup = [Environment]::GetFolderPath("Startup")
$ShortcutPath = Join-Path $Startup "Personal Asset OS.lnk"
$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = (Get-Command wscript.exe -ErrorAction Stop).Source
$Shortcut.Arguments = "`"$Launcher`""
$Shortcut.WorkingDirectory = $ProjectRoot
$Shortcut.Description = "Start Personal Asset OS in the Windows system tray"
$Shortcut.Save()
[pscustomobject]@{ installed = $true; shortcut = $ShortcutPath; launcher = $Launcher } | ConvertTo-Json
