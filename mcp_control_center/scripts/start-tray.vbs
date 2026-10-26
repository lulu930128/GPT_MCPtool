Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
managerRoot = fso.GetParentFolderName(scriptDir)
shell.CurrentDirectory = managerRoot
If fso.FileExists(managerRoot & "\config\installed-release.json") Then
    ' Hide the console at creation, before Windows Terminal can host it.
    ' Wait keeps the launcher alive for the installed tray's Explorer lineage check.
    command = Chr(34) & shell.ExpandEnvironmentStrings("%WINDIR%\System32\WindowsPowerShell\v1.0\powershell.exe") & Chr(34) & " -NoProfile -WindowStyle Hidden -File " & Chr(34) & scriptDir & "\tray.ps1" & Chr(34) & " -AutoReconcile"
    WScript.Quit shell.Run(command, 0, True)
Else
    command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File " & Chr(34) & scriptDir & "\tray.ps1" & Chr(34) & " -AutoReconcile"
    shell.Run command, 0, False
End If
