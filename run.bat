@echo off
chcp 65001 > nul

:: node_modules 없으면 setup 먼저 안내
if not exist "%~dp0node_modules" (
  echo.
  echo [안내] 처음 실행 시 setup.bat 을 먼저 실행해 주세요.
  echo.
  pause
  exit /b 1
)

node "%~dp0index.js"
pause
