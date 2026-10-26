Option Explicit
Dim shell, fso, scriptDir, command, boot
boot = False
If WScript.Arguments.Count = 1 Then
    If WScript.Arguments(0) <> "--boot" Then WScript.Quit 2
    boot = True
ElseIf WScript.Arguments.Count <> 0 Then
    WScript.Quit 2
End If
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
command = Chr(34) & shell.ExpandEnvironmentStrings("%WINDIR%\System32\WindowsPowerShell\v1.0\powershell.exe") & Chr(34) & " -NoProfile -WindowStyle Hidden -File " & Chr(34) & scriptDir & "\start-runtime-tray.ps1" & Chr(34)
If boot Then command = command & " -Boot"
WScript.Quit shell.Run(command, 0, True)
