Set shell = CreateObject("WScript.Shell")
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File " & Chr(34) & scriptDir & "\tray.ps1" & Chr(34) & " -DiagnosticOnly"
shell.Run command, 0, False
