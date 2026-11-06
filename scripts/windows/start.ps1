# Melody: starts the bot and restarts it after a crash. Started by start.cmd.
. (Join-Path $PSScriptRoot 'common.ps1')

Assert-Ready
if (-not (Test-Configured)) {
    Write-Step 'Бот ещё не настроен, запускаю настройку'
    Invoke-SetupWizard
}

$restartDelaySec = 10
$crashes = 0
Push-Location $Root
try {
    while ($true) {
        Write-Step 'Бот запущен. Остановить: Ctrl+C (или закройте окно).'
        $startedAt = Get-Date
        node.exe dist\index.js
        $code = $LASTEXITCODE
        $ranSec = ((Get-Date) - $startedAt).TotalSeconds
        if ($code -eq 0) {
            Write-Host 'Бот остановлен.'
            break
        }
        if ($ranSec -lt 60) {
            # A failure right at start is a setup problem; restarting would only repeat it.
            Write-Host ''
            Write-Host "Бот не запустился (код $code). Причина — в строках выше." -ForegroundColor Red
            Write-Host 'Частые причины: неверный токен (запустите setup.cmd), нет интернета, файл .env испорчен.'
            break
        }
        $crashes += 1
        Write-Host "Бот остановился с ошибкой (код $code). Перезапуск через $restartDelaySec с… (перезапусков: $crashes)" -ForegroundColor Yellow
        Start-Sleep -Seconds $restartDelaySec
    }
} finally {
    Pop-Location
}
