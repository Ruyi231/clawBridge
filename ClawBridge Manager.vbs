Option Explicit

Dim shell, fileSystem, projectRoot, managerScript, powerShell, command
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

projectRoot = fileSystem.GetParentFolderName(WScript.ScriptFullName)
managerScript = fileSystem.BuildPath(projectRoot, "scripts\launch-manager.ps1")
powerShell = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")

If Not fileSystem.FileExists(managerScript) Then
  MsgBox "ClawBridge manager script was not found:" & vbCrLf & managerScript, vbCritical, "ClawBridge Manager"
  WScript.Quit 1
End If

If WScript.Arguments.Named.Exists("validate") Then
  WScript.Quit 0
End If

command = Quote(powerShell) & " -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Quote(managerScript)
shell.Run command, 0, False

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
