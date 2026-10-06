FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json persona.md ./
COPY src ./src
RUN npm run build && npm prune --omit=dev && mkdir -p /app/data /app/auth && chown -R node:node /app
USER node
CMD ["node", "dist/index.js"]
