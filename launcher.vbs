Dim fso, dir, exe, f, fo, WshShell
Set fso     = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

' ── 이미 실행 중인 브릿지 감지 ──────────────────────────────────────
Dim taskOut
taskOut = WshShell.Exec("tasklist /FI ""IMAGENAME eq aram-bridge*"" /NH").StdOut.ReadAll()
If InStr(taskOut, "aram-bridge") > 0 Then
  Dim ans
  ans = MsgBox("이미 실행 중인 ARAM 브릿지가 있어요!" & Chr(13) & Chr(13) & _
               "기존 브릿지를 종료하고 새로 시작할까요?", _
               36, "ARAM 브릿지")
  If ans = 6 Then  ' 예
    WshShell.Run "taskkill /F /IM aram-bridge*.exe", 0, True
    WScript.Sleep 1000
  Else
    WScript.Quit
  End If
End If

' ── 실행 파일 탐색 ──────────────────────────────────────────────────
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

' ── 백그라운드 숨김 실행 ──────────────────────────────────────────────
WshShell.Run """" & exe & """", 0, False

MsgBox "ARAM 브릿지가 백그라운드에서 시작됐어요!" & Chr(13) & Chr(13) & _
       "웹사이트 상단의  🟢 브릿지 연결됨  표시로 확인하세요." & Chr(13) & Chr(13) & _
       "종료할 땐 같은 폴더의  stop.vbs  를 실행하세요.", _
       64, "ARAM 브릿지"
