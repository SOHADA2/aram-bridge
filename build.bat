@echo off
chcp 65001 > nul
echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   ARAM 브릿지 .exe 빌드
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.

where node > nul 2>&1
if %errorlevel% neq 0 (
  echo [오류] Node.js가 필요합니다. nodejs.org 에서 설치해 주세요.
  pause & exit /b 1
)

echo [1/3] 의존성 설치 중...
call npm install
if %errorlevel% neq 0 ( echo 실패 & pause & exit /b 1 )

echo.
echo [2/3] pkg 설치 중...
call npm install -g pkg
if %errorlevel% neq 0 ( echo 실패 & pause & exit /b 1 )

echo.
echo [3/3] .exe 빌드 중 (수 분 소요)...
if not exist dist mkdir dist
call pkg . --targets node18-win-x64 --output dist\aram-bridge.exe
if %errorlevel% neq 0 ( echo 빌드 실패 & pause & exit /b 1 )

echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   완료! dist\aram-bridge.exe 생성됨
echo   이 파일을 GitHub Releases에 업로드하세요.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.
pause
