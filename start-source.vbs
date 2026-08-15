Option Explicit

Dim argument
Dim command
Dim exitCode
Dim fileSystem
Dim processEnvironment
Dim projectRoot
Dim quote
Dim scriptPath
Dim shell

argument = ""
If WScript.Arguments.Count > 1 Then
  MsgBox "Usage: start-source.vbs [--hidden | --check]", vbExclamation, "Connection Switcher"
  WScript.Quit 2
End If

If WScript.Arguments.Count = 1 Then
  argument = LCase(WScript.Arguments(0))
  If argument <> "--hidden" And argument <> "--check" Then
    MsgBox "Unsupported argument: " & WScript.Arguments(0), vbExclamation, "Connection Switcher"
    WScript.Quit 2
  End If
End If

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set processEnvironment = shell.Environment("Process")

projectRoot = fileSystem.GetParentFolderName(WScript.ScriptFullName)
scriptPath = fileSystem.BuildPath(projectRoot, "start-source.cmd")
If Not fileSystem.FileExists(scriptPath) Then
  MsgBox "start-source.cmd was not found.", vbCritical, "Connection Switcher"
  WScript.Quit 1
End If

processEnvironment("NS_NO_PAUSE") = "1"
quote = Chr(34)
command = "cmd.exe /d /s /c " & quote & quote & scriptPath & quote
If Len(argument) > 0 Then command = command & " " & argument
command = command & quote

exitCode = shell.Run(command, 0, True)
If exitCode <> 0 Then
  MsgBox "Source startup failed with exit code " & exitCode & "." & vbCrLf & _
    "Run start-source.cmd --check for details.", vbCritical, "Connection Switcher"
End If

WScript.Quit exitCode
