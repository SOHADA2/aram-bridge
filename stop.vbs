Dim WshShell, taskOut
Set WshShell = CreateObject("WScript.Shell")

taskOut = WshShell.Exec("tasklist /FI ""IMAGENAME eq aram-bridge*"" /NH").StdOut.ReadAll()
If InStr(taskOut, "aram-bridge") > 0 Then
  WshShell.Run "taskkill /F /IM aram-bridge*.exe", 0, True
  MsgBox "ARAM 브릿지를 종료했어요.", 64, "ARAM 브릿지"
Else
  MsgBox "실행 중인 ARAM 브릿지가 없어요.", 64, "ARAM 브릿지"
End If
