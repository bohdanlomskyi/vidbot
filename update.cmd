@echo off
rem Melody: update to the latest version from GitHub. Double-click to run.
setlocal
cd /d "%~dp0"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\update.ps1"
set "MELODY_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %MELODY_EXIT%
