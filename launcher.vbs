Dim fso, dir, exe, f, fo, WshShell, taskOut
Set fso      = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

' ── 실행 중 여부 확인 ────────────────────────────────────────────────
taskOut = WshShell.Exec("tasklist /FI ""IMAGENAME eq aram-bridge*"" /NH").StdOut.ReadAll()
Dim isRunning : isRunning = (InStr(taskOut, "aram-bridge") > 0)

If isRunning Then
  ' ── 이미 실행 중 → 상태 페이지 열고 선택 ─────────────────────────
  WshShell.Run "cmd /c start http://localhost:7654", 0, False
  WScript.Sleep 300
  Dim ans
  ans = MsgBox("ARAM 브릿지가 실행 중이에요." & Chr(13) & Chr(13) & _
               "[예]  →  브릿지 종료" & Chr(13) & _
               "[아니오]  →  재시작 (기존 종료 후 새로 시작)", _
               3, "ARAM 브릿지")
  If ans = 6 Then      ' 예 → 종료만
    WshShell.Run "taskkill /F /IM aram-bridge*.exe", 0, True
    MsgBox "브릿지를 종료했어요.", 64, "ARAM 브릿지"
    WScript.Quit
  ElseIf ans = 7 Then  ' 아니오 → 재시작
    WshShell.Run "taskkill /F /IM aram-bridge*.exe", 0, True
    WScript.Sleep 1000
    ' 아래 시작 로직으로 계속 진행 (브라우저는 이미 열려 있음)
  Else                 ' 취소 → 그냥 닫기
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

' ── 백그라운드 숨김 실행 후 상태 페이지 열기 ─────────────────────────
WshShell.Run """" & exe & """", 0, False
WScript.Sleep 1500
WshShell.Run "cmd /c start http://localhost:7654", 0, False
