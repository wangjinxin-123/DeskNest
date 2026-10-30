' DeskNest launcher (no console window)
' Clears environment variables that break Electron startup (e.g. ELECTRON_RUN_AS_NODE=1,
' which makes electron.exe run as plain Node and exit immediately -> "double click does nothing").
' NOTE: keep this file ASCII-only. Windows Script Host reads .vbs as ANSI, so non-ASCII
' text inside string literals breaks the script with "unterminated statement".
Option Explicit

Dim sh, fso, base, exePath, cmdLine
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

base = fso.GetParentFolderName(WScript.ScriptFullName)
exePath = base & "\node_modules\electron\dist\electron.exe"

If Not fso.FileExists(exePath) Then
  MsgBox "Electron runtime not found:" & vbCrLf & exePath & vbCrLf & vbCrLf & _
         "Run 'npm install' inside that folder first (see README).", 48, "DeskNest"
  WScript.Quit 1
End If

' Clear the variable for the child process, then start Electron detached (0 = hidden cmd).
cmdLine = "cmd /c set ""ELECTRON_RUN_AS_NODE="" && start """" """ & exePath & """ """ & base & """"
sh.CurrentDirectory = base
sh.Run cmdLine, 0, False