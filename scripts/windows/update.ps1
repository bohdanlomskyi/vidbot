# Melody: updates the bot to the latest version from GitHub. Started by update.cmd.
# Your settings (.env), database (data), music (music) and stream catalog stay untouched.
. (Join-Path $PSScriptRoot 'common.ps1')

$Repo = 'bohdanlomskyi/vidbot'
$sourceFile = Join-Path $Tools 'source.txt'

Write-Step 'Обновление Melody'
# Windows locks the native modules of a running bot, so the update must not run alongside it.
$health = Join-Path $Root 'data\health.json'
if (Test-Path -LiteralPath $health) {
    try {
        $state = Get-Content -LiteralPath $health -Raw | ConvertFrom-Json
        $age = ((Get-Date).ToUniversalTime() - ([datetime]$state.updatedAt).ToUniversalTime()).TotalSeconds
        if ($state.status -eq 'ready' -and $age -lt 90) {
            Write-Host 'Похоже, бот сейчас запущен. Закройте его окно (или нажмите в нём Ctrl+C).' -ForegroundColor Yellow
            Read-Host 'Когда бот будет остановлен, нажмите Enter'
        }
    } catch { }
}
New-Item -ItemType Directory -Force -Path $Tools | Out-Null
$git = Get-Command git.exe -ErrorAction SilentlyContinue
if ($null -ne $git -and (Test-Path -LiteralPath (Join-Path $Root '.git'))) {
    Push-Location $Root
    try { Invoke-Checked 'git pull' { git.exe pull --ff-only } } finally { Pop-Location }
} else {
    $refs = @()
    if (Test-Path -LiteralPath $sourceFile) { $refs += (Get-Content -LiteralPath $sourceFile -Raw).Trim() }
    $refs += 'main'
    # A ZIP install has no source.txt. Until the guide lives on main, it is on this branch.
    $refs += 'claude/quirky-brahmagupta-lz9mjn'
    $temp = Join-Path ([IO.Path]::GetTempPath()) ("melody-update-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $temp | Out-Null
    try {
        $source = $null
        foreach ($ref in ($refs | Select-Object -Unique)) {
            Write-Host "Скачиваю последнюю версию ($ref)…"
            $zip = Join-Path $temp 'melody.zip'
            try {
                Invoke-WebRequest -UseBasicParsing -Uri "https://codeload.github.com/$Repo/zip/refs/heads/$ref" -OutFile $zip
            } catch {
                continue
            }
            $unpacked = Join-Path $temp $ref.Replace('/', '-')
            Expand-Archive -LiteralPath $zip -DestinationPath $unpacked -Force
            $folder = Get-ChildItem -LiteralPath $unpacked -Directory | Select-Object -First 1
            if ($null -ne $folder -and (Test-Path -LiteralPath (Join-Path $folder.FullName 'scripts\windows\install.ps1'))) {
                $source = $folder
                Set-Content -LiteralPath $sourceFile -Value $ref -Encoding ASCII
                break
            }
        }
        if ($null -eq $source) { Stop-WithError 'Не удалось скачать обновление с GitHub. Ничего не изменено.' }
        # Copying over the folder only adds and replaces program files; .env, data and the music
        # library are not in the archive, so they are never overwritten.
        Copy-Item -Path (Join-Path $source.FullName '*') -Destination $Root -Recurse -Force
    } finally {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Use-Node
Install-Dependencies
Build-Bot
if (Test-Configured) {
    Write-Step 'Обновляю команды в Discord'
    Push-Location $Root
    try { node.exe dist\scripts\register-commands.js } finally { Pop-Location }
}
Write-Host ''
Write-Ok 'Обновление завершено. Запустите бота: start.cmd (если он работал, перезапустите его).'
