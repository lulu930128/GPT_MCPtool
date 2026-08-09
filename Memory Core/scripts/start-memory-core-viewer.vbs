Option Explicit

Dim shell, scriptDirectory, command
Set shell = CreateObject("WScript.Shell")
scriptDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & _
    scriptDirectory & "\start_memory_core_viewer.ps1"""
shell.Run command, 0, False
