Option Explicit
Dim fso, shell, base
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = base
' 0 = janela oculta; True = aguarda o servidor terminar
shell.Run "cmd /c ""python app.py >> server.log 2>&1""", 0, True
