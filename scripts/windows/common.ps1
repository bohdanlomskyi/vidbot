# Shared helpers for the Windows scripts. Windows PowerShell 5.1 compatible.
# Everything is installed inside the project folder (.tools); nothing needs administrator rights.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Tools = Join-Path $Root '.tools'
$NodeVersion = (Get-Content -LiteralPath (Join-Path $Root '.nvmrc') -Raw).Trim()
try { $Host.UI.RawUI.WindowTitle = 'Melody' } catch { }

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host "== $Text" -ForegroundColor Cyan
}

function Write-Ok([string]$Text) { Write-Host $Text -ForegroundColor Green }

function Stop-WithError([string]$Text) {
    Write-Host ''
    Write-Host $Text -ForegroundColor Red
    exit 1
}

function Read-YesNo([string]$Question, [bool]$DefaultYes) {
    $hint = if ($DefaultYes) { '[Д/н]' } else { '[д/Н]' }
    while ($true) {
        $answer = (Read-Host "$Question $hint").Trim().ToLower()
        if ($answer -eq '') { return $DefaultYes }
        if (@('д', 'да', 'y', 'yes') -contains $answer) { return $true }
        if (@('н', 'нет', 'n', 'no') -contains $answer) { return $false }
        Write-Host 'Ответьте «д» (да) или «н» (нет).'
    }
}

function Get-WebText([string]$Url) {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url
    if ($response.Content -is [byte[]]) { return [Text.Encoding]::UTF8.GetString($response.Content) }
    return [string]$response.Content
}

function Test-SuitableNode([string]$NodeExe) {
    try { $version = & $NodeExe --version 2>$null } catch { return $false }
    # Node 24.17 or newer within 24.x: the native audio modules ship ready builds for it.
    if ($version -match '^v24\.(\d+)\.') { return ([int]$Matches[1] -ge 17) }
    return $false
}

# Puts a suitable Node.js first on PATH for this window: the copy in .tools, an installed
# Node 24, or a freshly downloaded portable Node 24 (checked against nodejs.org checksums).
function Use-Node {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $name = "node-v$NodeVersion-win-$arch"
    $dir = Join-Path $Tools $name
    if (Test-Path -LiteralPath (Join-Path $dir 'node.exe')) {
        $env:Path = "$dir;$env:Path"
        return
    }
    $installed = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -ne $installed -and (Test-SuitableNode $installed.Source)) { return }

    Write-Step "Скачиваю Node.js $NodeVersion (около 30 МБ, только для этой папки)"
    New-Item -ItemType Directory -Force -Path $Tools | Out-Null
    $base = "https://nodejs.org/dist/v$NodeVersion"
    $line = (Get-WebText "$base/SHASUMS256.txt") -split "`n" | Where-Object { $_ -match "\s$([regex]::Escape($name)).zip\s*$" } | Select-Object -First 1
    if ($null -eq $line) { Stop-WithError "На nodejs.org нет контрольной суммы для $name.zip." }
    $expected = ($line.Trim() -split '\s+')[0].ToLower()
    $zip = Join-Path $Tools "$name.zip"
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$name.zip" -OutFile $zip
    $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected) {
        Remove-Item -LiteralPath $zip -Force
        Stop-WithError 'Node.js скачался повреждённым (контрольная сумма не совпала). Запустите ещё раз.'
    }
    Expand-Archive -LiteralPath $zip -DestinationPath $Tools -Force
    Remove-Item -LiteralPath $zip -Force
    $env:Path = "$dir;$env:Path"
    Write-Ok "Node.js $NodeVersion готов."
}

function Invoke-Checked([string]$What, [scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) { Stop-WithError "$What завершилось с ошибкой (код $LASTEXITCODE). Сообщение выше." }
}

# Installs the npm packages without compiling anything: better-sqlite3 ships builds for
# Windows, and the Opus build for this Node version is downloaded by its own installer.
function Install-Dependencies {
    Write-Step 'Устанавливаю зависимости (1–3 минуты)'
    Push-Location $Root
    try {
        Invoke-Checked 'Установка пакетов' { npm.cmd ci --ignore-scripts --no-audit --no-fund }
        Invoke-Checked 'Загрузка Opus' { npm.cmd rebuild '@discordjs/opus' }
        Invoke-Checked 'Проверка Opus' { node.exe -e "require('@discordjs/opus')" }
    } finally {
        Pop-Location
    }
    Write-Ok 'Зависимости установлены.'
}

function Test-BuildCurrent {
    $entry = Join-Path $Root 'dist\index.js'
    if (-not (Test-Path -LiteralPath $entry)) { return $false }
    $built = (Get-Item -LiteralPath $entry).LastWriteTimeUtc
    $newer = Get-ChildItem -LiteralPath (Join-Path $Root 'src') -Recurse -File | Where-Object { $_.LastWriteTimeUtc -gt $built } | Select-Object -First 1
    return ($null -eq $newer)
}

function Build-Bot {
    Write-Step 'Собираю бота'
    Push-Location $Root
    try { Invoke-Checked 'Сборка' { npm.cmd run build --silent } } finally { Pop-Location }
}

function Test-Configured {
    $envFile = Join-Path $Root '.env'
    if (-not (Test-Path -LiteralPath $envFile)) { return $false }
    return [bool](Select-String -LiteralPath $envFile -Pattern '^\s*DISCORD_TOKEN\s*=\s*\S' -Quiet)
}

function Invoke-SetupWizard {
    Push-Location $Root
    try {
        node.exe dist\scripts\setup.js
        if ($LASTEXITCODE -ne 0) { Stop-WithError 'Настройка не завершена. Запустите setup.cmd, чтобы продолжить.' }
    } finally {
        Pop-Location
    }
}

function Assert-Ready {
    Use-Node
    if (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules\discord.js'))) { Install-Dependencies }
    if (-not (Test-BuildCurrent)) { Build-Bot }
}
