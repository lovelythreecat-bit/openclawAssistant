@echo off
setlocal
cd /d "%~dp0"
if exist "release\win-unpacked\Kuro.exe" (
  start "" "release\win-unpacked\Kuro.exe"
  exit /b 0
)
if exist "release\Kuro-0.1.0-Windows-x64.exe" (
  start "" "release\Kuro-0.1.0-Windows-x64.exe"
  exit /b 0
)
call npm.cmd start
if errorlevel 1 pause
