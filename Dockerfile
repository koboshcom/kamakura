FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Optional Discord self voice runtime. OFF by default; binary extension only.
ARG DISCORD_VOICE_BUILD=false
COPY voice/install.sh /tmp/install-discord-voice.sh
RUN if [ "$DISCORD_VOICE_BUILD" = true ]; then \
      apt-get update && apt-get install -y --no-install-recommends python3-venv git libopus0 && \
      sh /tmp/install-discord-voice.sh /app/voice-venv && \
      rm -rf /var/lib/apt/lists/*; \
    elif [ "$DISCORD_VOICE_BUILD" != false ]; then exit 1; fi
COPY package*.json ./
RUN npm ci
COPY tsconfig.json persona.md identity.json ./
COPY src ./src
COPY voice ./voice
RUN npm run build && npm prune --omit=dev && mkdir -p /app/data /app/auth && chown -R node:node /app
USER node
CMD ["node", "dist/index.js"]
