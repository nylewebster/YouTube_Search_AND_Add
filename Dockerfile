# Node 20 (matches package.json "engines"), on Debian slim so apt-get
# is available for ffmpeg. Railway auto-detects this file and switches
# from Nixpacks to the Docker builder automatically — no config needed
# beyond committing this at the repo root.
FROM node:20-slim

# ffmpeg: required by yt-dlp's audio extraction (-x / --audio-format mp3).
# ca-certificates + curl: needed only to fetch the yt-dlp binary below.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp as a standalone binary — specifically yt-dlp_linux, the
# PyInstaller-bundled build with Python embedded inside it. The plain
# "yt-dlp" release asset is a Python zipapp (shebang #!/usr/bin/env
# python3) and FAILS on this Python-less base image with
# "python3: No such file or directory" — yt-dlp_linux avoids that
# entirely by not depending on a system Python at all.
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# Separate dependency install from source copy so Docker's layer cache
# avoids reinstalling npm packages on every code-only change.
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/index.js"]
