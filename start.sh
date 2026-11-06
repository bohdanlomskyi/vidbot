#!/usr/bin/env bash
# Melody: starts the bot and restarts it after a crash. Run: ./start.sh
# For a server that runs around the clock, Docker (see README) is the better choice.
set -uo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules/discord.js ]; then
  npm ci --no-audit --no-fund || exit 1
fi
if [ ! -f dist/index.js ] || [ -n "$(find src -newer dist/index.js -type f -print -quit)" ]; then
  npm run build --silent || exit 1
fi
if ! grep -Eq '^[[:space:]]*DISCORD_TOKEN[[:space:]]*=[[:space:]]*[^[:space:]]' .env 2>/dev/null; then
  node dist/scripts/setup.js || exit 1
fi

crashes=0
while true; do
  printf '\n== Бот запущен. Остановить: Ctrl+C\n'
  started=$(date +%s)
  node dist/index.js
  code=$?
  ran=$(( $(date +%s) - started ))
  if [ "$code" -eq 0 ] || [ "$code" -eq 130 ]; then
    echo 'Бот остановлен.'
    exit 0
  fi
  if [ "$ran" -lt 60 ]; then
    echo "Бот не запустился (код $code). Причина — в строках выше. Изменить настройки: npm run setup"
    exit "$code"
  fi
  crashes=$((crashes + 1))
  echo "Бот остановился с ошибкой (код $code). Перезапуск через 10 с (перезапусков: $crashes)."
  sleep 10
done
