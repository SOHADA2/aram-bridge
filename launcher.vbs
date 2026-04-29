Dim fso, dir, exe, f, fo
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

' 같은 폴더에서 aram-bridge-*.exe 찾기
Set fo = fso.GetFolder(dir)
exe = ""
For Each f In fo.Files
  If LCase(Left(f.Name, 12)) = "aram-bridge-" And LCase(Right(f.Name, 4)) = ".exe" Then
    exe = f.Path
    Exit For
  End If
Next

If exe = "" Then
  MsgBox "aram-bridge 실행 파일을 찾을 수 없어요." & Chr(13) & Chr(13) & _
         "launcher.vbs 와 aram-bridge-vX.X.X.exe 가 같은 폴더에 있어야 해요.", _
         16, "ARAM 브릿지"
  WScript.Quit
End If

' 백그라운드 숨김 실행 (창 없음)
CreateObject("WScript.Shell").Run """" & exe & """", 0, False

MsgBox "ARAM 브릿지가 백그라운드에서 시작됐어요!" & Chr(13) & Chr(13) & _
       "웹사이트 상단의  🟢 브릿지 연결됨  표시로 확인하세요." & Chr(13) & _
       "종료하려면 작업 관리자에서 aram-bridge 프로세스를 끝내세요.", _
       64, "ARAM 브릿지"
