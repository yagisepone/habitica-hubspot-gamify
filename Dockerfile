# Node.js + pm2 + ts-node 実行型（ビルド不要）
FROM node:20-alpine

# JST固定（cronの時刻ズレ防止）
RUN apk add --no-cache tzdata \
 && cp /usr/share/zoneinfo/Asia/Tokyo /etc/localtime \
 && echo "Asia/Tokyo" > /etc/timezone

ENV TZ=Asia/Tokyo \
    NODE_ENV=production \
    PORT=3000

WORKDIR /app

# 依存だけ先に入れてビルドキャッシュ効かせる
COPY package*.json ./
RUN npm ci || npm install

# アプリ本体コピー
COPY . .

# pm2/ts-node/typescript をグローバル導入（ts実行用）
RUN npm i -g pm2 ts-node typescript

EXPOSE 3000

# WebとCronをpm2で同時起動
CMD sh -c "pm2 start 'ts-node src/web/server.ts' --name gamify-web --time \
  && pm2 start 'ts-node src/scheduler/cron.ts' --name gamify-cron --time \
  && pm2-runtime"
