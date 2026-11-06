# Melody: first installation on Windows. Started by install.cmd.
. (Join-Path $PSScriptRoot 'common.ps1')

Write-Host 'Melody: установка. Нужен только интернет; права администратора не нужны.' -ForegroundColor Cyan
# Files from a downloaded ZIP are marked as coming from the internet. Unblocking them stops
# Windows from asking about every script later. Only this folder is touched.
Get-ChildItem -LiteralPath $Root -Recurse -File -Include *.cmd, *.ps1 -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue

Use-Node
Install-Dependencies
Build-Bot

Write-Step 'Настройка бота'
Invoke-SetupWizard

Write-Step 'Ярлыки'
$shell = New-Object -ComObject WScript.Shell
$start = Join-Path $Root 'start.cmd'
if (Read-YesNo 'Создать ярлык «Melody» на рабочем столе?' $true) {
    $link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Melody.lnk'))
    $link.TargetPath = $start
    $link.WorkingDirectory = $Root
    $link.Description = 'Запустить музыкального бота Melody'
    $link.Save()
    Write-Ok 'Ярлык создан.'
}
if (Read-YesNo 'Запускать бота автоматически при входе в Windows?' $false) {
    $link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'Melody.lnk'))
    $link.TargetPath = $start
    $link.WorkingDirectory = $Root
    $link.WindowStyle = 7
    $link.Save()
    Write-Ok 'Автозапуск включён. Отключить: удалите ярлык Melody из папки shell:startup.'
}

Write-Host ''
Write-Ok 'Установка завершена.'
if (Read-YesNo 'Запустить бота сейчас?' $true) {
    & (Join-Path $PSScriptRoot 'start.ps1')
} else {
    Write-Host 'Запуск позже: start.cmd или ярлык «Melody».'
}
