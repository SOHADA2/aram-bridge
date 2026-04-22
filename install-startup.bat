@echo off
chcp 65001 > nul
echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   윈도우 시작프로그램에 등록
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.

set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set SHORTCUT=%STARTUP%\aram-bridge.bat
set TARGET=%~dp0run.bat

echo 등록 경로: %SHORTCUT%

:: 시작프로그램 폴더에 bat 복사 (바로가기 대신 래퍼 bat)
(
  echo @echo off
  echo cd /d "%~dp0"
  echo start "" /min cmd /c "%TARGET%"
) > "%SHORTCUT%"

if %errorlevel% equ 0 (
  echo.
  echo 등록 완료! 다음 Windows 시작 시 자동 실행됩니다.
) else (
  echo.
  echo [오류] 등록 실패. 관리자 권한으로 실행해 보세요.
)
echo.
pause
