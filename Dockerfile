FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=7860
ENV ENABLE_TELEGRAM_BOT=true
ENV ENABLE_EXECUTOR_WORKER=true
ENV ENABLE_MONITOR_WORKER=true
ENV ENABLE_SNIPER_WORKER=true
ENV ENABLE_METRICS_SNAPSHOT_LOGS=false

EXPOSE 7860

CMD ["sh", "-c", "node dist/scripts/migrate.js && node --max-old-space-size=8192 dist/allInOne.js"]
