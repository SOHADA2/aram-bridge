@echo off
chcp 65001 > nul
echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   ARAM 브릿지 설치 중...
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.

:: Node.js 확인
where node > nul 2>&1
if %errorlevel% neq 0 (
  echo [오류] Node.js가 설치되어 있지 않습니다.
  echo   https://nodejs.org 에서 LTS 버전을 설치해 주세요.
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
echo Node.js 버전: %NODE_VER%
echo.

:: npm install
echo 패키지 설치 중 (인터넷 연결 필요)...
npm install
if %errorlevel% neq 0 (
  echo.
  echo [오류] 패키지 설치 실패. 인터넷 연결을 확인해 주세요.
  pause
  exit /b 1
)

echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo   설치 완료! run.bat 으로 실행하세요.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.
pause
