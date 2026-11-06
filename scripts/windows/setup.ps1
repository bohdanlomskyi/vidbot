# Melody: change the settings (token, server, FFmpeg, YouTube). Started by setup.cmd.
. (Join-Path $PSScriptRoot 'common.ps1')

Assert-Ready
Invoke-SetupWizard
Write-Host ''
Write-Ok 'Готово. Если бот уже запущен, перезапустите его, чтобы применить настройки.'
