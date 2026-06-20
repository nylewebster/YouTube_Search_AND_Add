# Node 20 (matches package.json "engines"), on Debian slim so apt-get
# is available for ffmpeg. Railway auto-detects this file and switches
# from Nixpacks to the Docker builder automatically — no config needed
# beyond committing this at the repo root.
FROM node:20-slim

# ffmpeg: required by yt-dlp's audio extraction (-x / --audio-format mp3).
# ca-certificates + curl: needed to fetch the yt-dlp and deno binaries below.
# unzip: needed to extract Deno's release archive.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
      curl \
      unzip \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp as a standalone binary — specifically yt-dlp_linux, the
# PyInstaller-bundled build with Python embedded inside it. The plain
# "yt-dlp" release asset is a Python zipapp (shebang #!/usr/bin/env
# python3) and FAILS on this Python-less base image with
# "python3: No such file or directory" — yt-dlp_linux avoids that
# entirely by not depending on a system Python at all.
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Deno: as of yt-dlp 2025.11.12+, YouTube extraction requires an external
# JavaScript runtime to solve a signature/JS challenge — Deno is the one
# yt-dlp auto-detects and uses by default (no --js-runtimes flag needed),
# other runtimes like Node require explicitly opting in. The supporting
# yt-dlp-ejs component is already bundled into the yt-dlp_linux binary
# above, so installing the runtime itself is all that's needed.
# See https://github.com/yt-dlp/yt-dlp/wiki/EJS for background.
RUN curl -fsSL https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip \
    && unzip /tmp/deno.zip -d /usr/local/bin \
    && rm /tmp/deno.zip \
    && chmod a+rx /usr/local/bin/deno

WORKDIR /app

# Separate dependency install from source copy so Docker's layer cache
# avoids reinstalling npm packages on every code-only change.
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/index.js"]
