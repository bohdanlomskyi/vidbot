# Melody: one-line installer for Windows. Run in PowerShell:
#   irm https://raw.githubusercontent.com/bohdanlomskyi/vidbot/main/scripts/windows/bootstrap.ps1 | iex
# Saved as UTF-8 without BOM on purpose: it is meant to be read by irm and run by iex.
# It downloads Melody into %USERPROFILE%\Melody (or $env:MELODY_DIR) and starts install.ps1.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = 'bohdanlomskyi/vidbot'
$Refs = @('main', 'claude/quirky-brahmagupta-lz9mjn')
$Target = if ($env:MELODY_DIR) { $env:MELODY_DIR } else { Join-Path $HOME 'Melody' }

if (Test-Path -LiteralPath (Join-Path $Target 'package.json')) {
    Write-Host "Melody уже установлен в $Target. Запускаю обновление." -ForegroundColor Cyan
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Target 'scripts\windows\update.ps1')
    return
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ('melody-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null
try {
    $found = $null
    foreach ($ref in $Refs) {
        Write-Host "Скачиваю Melody ($ref)…"
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
            $found = @{ Folder = $folder.FullName; Ref = $ref }
            break
        }
    }
    if ($null -eq $found) { throw 'Не удалось скачать Melody с GitHub. Проверьте интернет.' }
    New-Item -ItemType Directory -Force -Path $Target | Out-Null
    Copy-Item -Path (Join-Path $found.Folder '*') -Destination $Target -Recurse -Force
    New-Item -ItemType Directory -Force -Path (Join-Path $Target '.tools') | Out-Null
    Set-Content -LiteralPath (Join-Path $Target '.tools\source.txt') -Value $found.Ref -Encoding ASCII
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Melody скачан в $Target" -ForegroundColor Green
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Target 'scripts\windows\install.ps1')
