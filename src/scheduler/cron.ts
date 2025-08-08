import cron from "node-cron";
import yaml from "js-yaml";
import fs from "fs";
import 'dotenv/config';
import { run } from "../orchestrator/index";

function loadSchedule() {
  const obj = yaml.load(fs.readFileSync("config/schedule.yml", "utf-8")) as any;
  const timezone = obj?.timezone || "Asia/Tokyo";
  const daily = obj?.daily_time || "18:05"; // HH:mm
  const [hh, mm] = daily.split(":").map((x: string) => parseInt(x, 10));
  // node-cron は分・時の順
  const cronExpr = `${mm} ${hh} * * *`;
  return { cronExpr, timezone };
}

// サービスとして常駐させる想定
const { cronExpr, timezone } = loadSchedule();
console.log(`[scheduler] cron=${cronExpr} tz=${timezone}`);
cron.schedule(cronExpr, async () => {
  console.log(`[scheduler] tick @${new Date().toISOString()}`);
  await run().catch(console.error);
}, { timezone });

// すぐ1回走らせたいとき（ローカル確認用）:
// run().catch(console.error);
