# syntax=docker/dockerfile:1

# Node.js 24.22.2 on Debian trixie (slim). The tag exists on Docker Hub (library/node, linux/amd64).
ARG NODE_IMAGE=node:24.22.2-trixie-slim

# Optional yt-dlp for the experimental YouTube provider. Nothing is downloaded unless YTDLP_VERSION
# is set, and a checksum is then mandatory. The output directory is copied even when empty.
FROM ${NODE_IMAGE} AS ytdlp
ARG YTDLP_VERSION=
ARG YTDLP_SHA256=
RUN set -eux; \
    mkdir -p /out; \
    if [ -n "${YTDLP_VERSION}" ]; then \
      test -n "${YTDLP_SHA256}" || { echo "YTDLP_SHA256 is required when YTDLP_VERSION is set" >&2; exit 1; }; \
      apt-get update; \
      apt-get install -y --no-install-recommends ca-certificates curl; \
      curl -fsSL -o /out/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp"; \
      echo "${YTDLP_SHA256}  /out/yt-dlp" | sha256sum -c -; \
      chmod 0755 /out/yt-dlp; \
      rm -rf /var/lib/apt/lists/*; \
    fi

# Installs every dependency, including native modules (@discordjs/opus, better-sqlite3).
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends python3 make g++; \
    rm -rf /var/lib/apt/lists/*; \
    npm ci --no-audit --no-fund

# Compiles TypeScript and keeps only production dependencies.
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    DATABASE_PATH=/app/data/melody.sqlite \
    HEALTH_FILE=/app/data/health.json \
    MUSIC_DIR=/app/music \
    STREAM_CATALOG_FILE=/app/config/streams.json \
    FFMPEG_PATH=ffmpeg \
    FFPROBE_PATH=ffprobe \
    YTDLP_PATH=/usr/local/bin/yt-dlp
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ffmpeg ca-certificates; \
    rm -rf /var/lib/apt/lists/*; \
    mkdir -p /app/data /app/music /app/config; \
    chown -R node:node /app/data
WORKDIR /app
COPY --from=ytdlp /out/ /usr/local/bin/
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD ["node", "dist/scripts/healthcheck.js"]
CMD ["node", "dist/index.js"]
