# Развёртывание

Самый простой путь описан в [README](../README.md#установка-на-windows-3-шага-около-5-минут): `install.cmd` на Windows или `./install.sh` на Linux и macOS. Ниже — подробности и статус проверки.

| Установщик                                                                                         | Статус                                | Как проверено                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Мастер настройки (`npm run setup`): `.env`, Client ID по токену, выбор сервера, YouTube на сервере | проверено с подменой Discord          | `tests/integration/setupWizard.test.ts`: настоящий скрипт, ответы на входе, токен не попадает в вывод                                                                                                                          |
| Загрузка yt-dlp с проверкой SHA-256                                                                | проверено на реальной сети            | сборка для Linux скачана с GitHub, сумма сверена с `SHA2-256SUMS`, программа запущена                                                                                                                                          |
| Загрузка FFmpeg и Node.js для Windows                                                              | частично                              | адреса и файлы контрольных сумм доступны; распаковка и запуск под Windows не выполнялись                                                                                                                                       |
| Скрипты `install.cmd`, `start.cmd`, `setup.cmd`, `update.cmd` и `scripts/windows/*.ps1`            | не запускались на Windows             | чтение кода на совместимость с Windows PowerShell 5.1, тесты кодировки (UTF-8 с BOM), окончаний строк (CRLF) и ссылок между файлами; PowerShell эти файлы не разбирал, размеры и время загрузки Node.js и FFmpeg не измерялись |
| `install.sh`, `start.sh`                                                                           | `start.sh` проверен, `install.sh` нет | `start.sh` собрал бота, запустил его и при ошибке входа остановился без цикла перезапусков; `install.sh` проверен только `bash -n`                                                                                             |

## Что проверено и что нет

| Часть                                                                                                                                    | Статус           | Как проверено                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Сборка TypeScript, линтер, форматирование, тесты                                                                                         | проверено        | `npm run check`                                                                                                                 |
| Запуск собранного бота: сборка сервисов, подключение к базе, сканирование библиотеки, попытка входа в Discord, остановка, файл состояния | проверено        | запуск `node dist/index.js` с заведомо неверным токеном: вход отклонён, бот записал состояние `stopping` и завершился с кодом 1 |
| Диагностика `npm run doctor`                                                                                                             | проверено        | все проверки ОК или ПРОПУСК, код возврата 0                                                                                     |
| Проверка работоспособности `healthcheck`                                                                                                 | проверено        | при состоянии `stopping` возвращает код 1 с причиной                                                                            |
| Генерация тестового тона и сканирование библиотеки                                                                                       | проверено        | `npm run library:tone`, `npm run library:scan`                                                                                  |
| Загрузка Opus, DAVE и шифрования AES-256-GCM                                                                                             | проверено        | `npm run doctor`, тесты; Opus кодирует поток PCM в пакеты                                                                       |
| Голосовое подключение и обмен ключами DAVE с Discord                                                                                     | **не проверено** | нужны живые тесты, см. [tests/live/README.md](../tests/live/README.md)                                                          |
| Команды и панель в настоящем Discord                                                                                                     | **не проверено** | нужен тестовый сервер                                                                                                           |
| YouTube и yt-dlp                                                                                                                         | **не проверено** | yt-dlp в среде не установлен                                                                                                    |
| Сборка и запуск Docker-образа                                                                                                            | **не проверено** | в среде нет Docker-демона                                                                                                       |
| Статическая проверка Docker-файлов                                                                                                       | проверено        | тесты `tests/unit/deployment.test.ts`, `docker compose config`                                                                  |
| Существование базового образа `node:24.22.2-trixie-slim`                                                                                 | проверено        | Docker Hub API: тег есть для linux/amd64                                                                                        |
| Windows и macOS                                                                                                                          | **не проверено** | —                                                                                                                               |

## Локальный запуск на Linux

1. Установите Node.js. Версия должна быть не ниже 24.17.0; проверенная версия — 24.22.2, она указана в `.nvmrc`.
2. Установите FFmpeg вместе с ffprobe. На Debian и Ubuntu: `sudo apt install ffmpeg`.
3. В каталоге проекта выполните:

   ```bash
   npm ci
   cp .env.example .env
   # заполните DISCORD_TOKEN и DISCORD_CLIENT_ID
   npm run build
   npm run doctor
   npm run commands:register
   npm start
   ```

## Локальный запуск на Windows

Не проверено в этой среде. Инструкция основана на стандартных способах установки.

1. Установите Node.js 24.x с официального сайта.
2. Установите FFmpeg: скачайте сборку с ffmpeg.org или выполните `winget install Gyan.FFmpeg`. Если `ffmpeg` и `ffprobe` не находятся в PATH, укажите полные пути в `FFMPEG_PATH` и `FFPROBE_PATH` в `.env`.
3. В PowerShell выполните `copy .env.example .env`, затем заполните файл и продолжите по шагам из раздела для Linux.

## Нативные модули

`@discordjs/opus` и `better-sqlite3` обычно ставятся из готовых сборок. Если установка завершилась ошибкой, установите инструменты сборки и повторите `npm ci`:

- Linux: `python3`, `make`, `g++` (пакет `build-essential`);
- Windows: Visual Studio Build Tools с компонентом C++ и Python 3;
- macOS: Xcode Command Line Tools.

В Docker-образе эти инструменты ставятся на стадии `deps` Dockerfile.

## Работа 24/7

Бот должен запускаться автоматически и перезапускаться при сбое. Два варианта:

- **Docker** с `restart: unless-stopped` — см. раздел ниже.
- **Менеджер процессов.** Пример для systemd (не проверен в этой среде):

  ```ini
  [Unit]
  Description=Melody Discord music bot
  After=network-online.target
  Wants=network-online.target

  [Service]
  WorkingDirectory=/opt/melody
  ExecStart=/usr/bin/env node dist/index.js
  EnvironmentFile=/opt/melody/.env
  Restart=on-failure
  User=melody

  [Install]
  WantedBy=multi-user.target
  ```

Бот корректно останавливается по `SIGTERM` и `SIGINT`: отменяет отложенные обновления панелей, отключается от голосовых каналов и закрывает базу. Сами панели в Discord остаются. На остановку отводится 15 секунд, после чего процесс завершается принудительно.

Для мониторинга используйте `node dist/scripts/healthcheck.js` (код возврата 0 — бот готов и обновляет файл состояния) и журнал в формате JSON.

## Docker

Требуются Docker Engine и Docker Compose v2.

```bash
cp .env.example .env
docker compose up -d --build
docker compose ps             # healthy означает, что проверка работоспособности проходит
docker compose logs -f bot
```

Регистрация команд и диагностика в контейнере:

```bash
docker compose run --rm bot node dist/scripts/register-commands.js
docker compose run --rm bot node dist/scripts/doctor.js
```

### Что делает `compose.yaml`

- Переменные окружения читаются из `.env`. Если файла нет, бот завершается с ошибкой конфигурации, а `restart: unless-stopped` перезапускает его. Причину смотрите в `docker compose logs bot`.
- Внутри контейнера переопределены пути: база и файл состояния в томе, музыка и каталог `config/` смонтированы только для чтения.
- Корневая файловая система только для чтения, временные файлы в `tmpfs`, все capabilities сняты, включён `no-new-privileges`.
- Входящие порты не публикуются.
- Журнал ограничен по размеру (10 МБ, три файла).

### Опциональный yt-dlp в образе

yt-dlp ставится только при явном запросе. Контрольная сумма обязательна:

```bash
docker compose build \
  --build-arg YTDLP_VERSION=<версия из релизов> \
  --build-arg YTDLP_SHA256=<sha256 файла yt-dlp из того же релиза>
docker compose up -d
```

Без `YTDLP_SHA256` сборка завершится ошибкой. Значения берите из страницы релиза yt-dlp на GitHub.

### Резервная копия и обновление

Резервная копия базы SQLite (том `melody-data`, имя проекта `melody`):

```bash
docker run --rm \
  -v melody_melody-data:/data \
  -v "$PWD":/backup \
  node:24.22.2-trixie-slim \
  tar czf /backup/melody-data.tgz -C /data .
```

Обновление:

```bash
git pull
docker compose up -d --build
docker compose run --rm bot node dist/scripts/register-commands.js   # если изменился набор команд
```

Остановка без удаления данных: `docker compose down`. Флаг `-v` удалит том с базой, поэтому используйте его только осознанно.

## Перед запуском в продакшене

1. `npm run check` проходит без ошибок.
2. `npm run doctor` даёт ОК для FFmpeg, ffprobe, базы, Opus, DAVE и шифрования.
3. Тестовый сервер проверен вручную: `/play` со звуком, панель, `/setup`, `/settings`.
4. Токен хранится только в `.env` (или в секретах оркестратора), а не в репозитории.
5. Для живой проверки голоса выполнены живые тесты (см. [tests/live/README.md](../tests/live/README.md)).
