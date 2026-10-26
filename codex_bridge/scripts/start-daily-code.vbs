Option Explicit
Dim shell, command
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "C:\GPT_MCPtool\codex_bridge"
command = """C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"" -NoProfile -WindowStyle Hidden -File ""C:\GPT_MCPtool\codex_bridge\scripts\daily-code-update.ps1"" -Action Start"
WScript.Quit shell.Run(command, 0, True)
