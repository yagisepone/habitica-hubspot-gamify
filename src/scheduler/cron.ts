import yaml from "js-yaml";
import fs from "fs";
import path from "path";
import cron from "node-cron";
import "dotenv/config";
import { runDaily } from "../orchestrator/daily";

type Schedules = { timezone?: string; daily_time?: string };

const cfg = yaml.load(
  fs.readFileSync(path.resolve(process.cwd(), "config/schedules.yml"), "utf-8")
) as Schedules;

const tz = cfg.timezone || "Asia/Tokyo";
const [hh, mm] = (cfg.daily_time || "18:05").split(":").map(n => parseInt(n, 10) || 0);

// node-cron は "分 時 * * *"
const expr = `${mm} ${hh} * * *`;
console.log(`[cron] schedule daily at ${cfg.daily_time} (${tz}) -> ${expr}`);

cron.schedule(expr, async () => {
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, "0");
  const d = String(today.getDate()).padStart(2, "0");
  const date = `${y}-${m}-${d}`;
  await runDaily(date);
}, { timezone: tz });
