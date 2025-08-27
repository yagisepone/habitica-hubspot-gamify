import cron from "node-cron";
import { spawn } from "child_process";
import fs from "fs";
import yaml from "js-yaml";
import { createTodo } from "../connectors/habitica";

const TZ = process.env.TZ || "Asia/Tokyo";

function runTsNode(script: string, args: string[] = []) {
  const p = spawn("npx", ["ts-node", script, ...args], { stdio: "inherit" });
  p.on("exit", (code) => console.log(`[cron] ${script} exited with code ${code}`));
}

function today() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// 18:05 JST 日報生成
cron.schedule("5 18 * * *", () => {
  const date = today();
  console.log(`[cron] daily report for ${date}`);
  runTsNode("src/orchestrator/daily.ts", ["--date", date]);
}, { timezone: TZ });

// 18:10 JST state更新
cron.schedule("10 18 * * *", () => {
  const date = today();
  console.log(`[cron] state_from_events for ${date}`);
  runTsNode("src/scripts/state_from_events.ts", ["--date", date]);
}, { timezone: TZ });

// 09:00 JST 自己目標To-Do配布（任意強化）
function forEachMemberHabitica(cb: (cred: { userId: string; apiToken: string }, name: string) => Promise<void>) {
  try {
    const y = yaml.load(fs.readFileSync("config/users.yml", "utf8")) as any;
    for (const m of (y?.members || [])) {
      if (m?.habitica_user_id && m?.habitica_api_token) {
        cb({ userId: m.habitica_user_id, apiToken: m.habitica_api_token }, m.name).catch(() => {});
      }
    }
  } catch { /* no-op */ }
}
cron.schedule("0 9 * * *", async () => {
  await forEachMemberHabitica(async (cred, name) => {
    await createTodo(`📝 今日の目標（${name}）`, `完了で+XP（Habitica標準）`, undefined, cred);
  });
}, { timezone: TZ });

console.log(`[cron] started with TZ=${TZ}`);
