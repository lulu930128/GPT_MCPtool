Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File " & Chr(34) & scriptDir & "\control-center-ui.ps1" & Chr(34) & " -Action open_study_browser"
shell.Run command, 0, False
