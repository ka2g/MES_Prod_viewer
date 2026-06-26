' outdoor-relay.exe 를 콘솔 창 없이 백그라운드 실행 (Win7+)
' 작업 스케줄러·시작프로그램에 이 VBS 경로를 등록하세요.

Option Explicit

Dim fso, shell, dir, exe

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
exe = dir & "\outdoor-relay.exe"

If Not fso.FileExists(exe) Then
  MsgBox "outdoor-relay.exe 를 찾을 수 없습니다." & vbCrLf & dir, vbCritical, "MES Outdoor Relay"
  WScript.Quit 1
End If

shell.CurrentDirectory = dir
' 0 = 창 숨김
shell.Run """" & exe & """", 0, False
