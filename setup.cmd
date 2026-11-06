@echo off
rem Melody: change settings (token, server, FFmpeg, YouTube). Double-click to run.
setlocal
cd /d "%~dp0"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\setup.ps1"
set "MELODY_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %MELODY_EXIT%
