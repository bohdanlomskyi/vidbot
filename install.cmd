@echo off
rem Melody: first installation (Node.js, packages, settings). Double-click to run.
setlocal
cd /d "%~dp0"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\install.ps1"
set "MELODY_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %MELODY_EXIT%
