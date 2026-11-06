#!/usr/bin/env bash
# Melody: installation on Linux and macOS. Run: ./install.sh
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n== %s\n' "$1"; }
fail() { printf '\n%s\n' "$1" >&2; exit 1; }

say 'Проверяю Node.js'
if ! command -v node >/dev/null 2>&1; then
  fail 'Node.js не найден. Установите Node.js 24 (например: nvm install 24) и запустите ./install.sh снова.'
fi
version="$(node --version)"
major="$(printf '%s' "$version" | sed -E 's/^v([0-9]+)\..*/\1/')"
minor="$(printf '%s' "$version" | sed -E 's/^v[0-9]+\.([0-9]+)\..*/\1/')"
if [ "$major" -lt 24 ] || { [ "$major" -eq 24 ] && [ "$minor" -lt 17 ]; }; then
  fail "Нужен Node.js 24.17 или новее, а установлен $version. Например: nvm install 24 && nvm use 24"
fi
echo "Node.js $version"

say 'Проверяю FFmpeg'
if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
  ffmpeg -version | head -n 1
else
  echo 'FFmpeg не найден. Установите его, иначе звука не будет:'
  echo '  Debian/Ubuntu: sudo apt install ffmpeg'
  echo '  Fedora:        sudo dnf install ffmpeg'
  echo '  macOS:         brew install ffmpeg'
fi

say 'Устанавливаю зависимости (1–3 минуты)'
npm ci --no-audit --no-fund
say 'Собираю бота'
npm run build --silent

say 'Настройка бота'
node dist/scripts/setup.js

printf '\nУстановка завершена. Запуск: ./start.sh\n'
