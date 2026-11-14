' Hidden launcher for the offline experiment (desktop shortcut target).
' Runs start-offline-archive.ps1 with no console window. App output goes to
' %APPDATA%\Mailspring-offline\logs\app.log (see the .ps1).
' Usage: wscript.exe start-offline-archive-hidden.vbs "D:\Yahoo-Offline\<run>\work"
Option Explicit
Dim fso, shell, here, ps1, archive, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(here, "start-offline-archive.ps1")
archive = ""
If WScript.Arguments.Count > 0 Then archive = WScript.Arguments(0)
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """"
If archive <> "" Then cmd = cmd & " -ArchivePath """ & archive & """"
' 0 = hidden window, False = do not wait
shell.Run cmd, 0, False
