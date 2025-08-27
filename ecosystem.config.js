// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "gamify-web",
      script: "npx",
      args: "ts-node src/web/server.ts",
      env: { PORT: "3000" },                 // デフォルト
      env_production: { TZ: "Asia/Tokyo", PORT: "3000" } // ← ここでTZを明示
    },
    {
      name: "gamify-cron",
      script: "npx",
      args: "ts-node src/scheduler/cron.ts",
      env: { },                              // デフォルト
      env_production: { TZ: "Asia/Tokyo" }   // ← ここでTZを明示
    }
  ]
};
