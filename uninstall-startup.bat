@echo off
chcp 65001 > nul
echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   시작프로그램에서 제거
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.

set SHORTCUT=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\aram-bridge.bat

if exist "%SHORTCUT%" (
  del "%SHORTCUT%"
  echo 제거 완료.
) else (
  echo 등록된 항목이 없습니다.
)
echo.
pause
