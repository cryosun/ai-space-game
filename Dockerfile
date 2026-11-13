# Cosmic Arena — образ для хостинга / VPS / локального Docker
FROM node:22-alpine

WORKDIR /app

# Сначала манифесты, чтобы слой с зависимостями кэшировался между сборками
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
# Статистику можно сохранять в том: -v arena_data:/data -e STATS_FILE=/data/stats.json
VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "server.js"]
