Option Explicit
Dim shell, fso, scriptDir, managerRoot, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
managerRoot = fso.GetParentFolderName(scriptDir)
If Not fso.FileExists(fso.GetParentFolderName(managerRoot) & "\daily-mode.json") Then WScript.Quit 1
shell.CurrentDirectory = managerRoot
command = """C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"" -NoProfile -WindowStyle Hidden -File """ & scriptDir & "\tray.ps1"""
If WScript.Arguments.Count = 1 Then
    If WScript.Arguments(0) <> "--self-test" Then WScript.Quit 2
    command = command & " -SelfTest"
ElseIf WScript.Arguments.Count <> 0 Then
    WScript.Quit 2
End If
WScript.Quit shell.Run(command, 0, True)
