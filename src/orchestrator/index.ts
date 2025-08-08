import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import tz from "dayjs/plugin/timezone";
import 'dotenv/config';
import { fetchDailyCallStats } from "../connectors/hubspot";
import { addXpForKpi } from "../connectors/habitica";
dayjs.extend(utc); dayjs.extend(tz);

type Member = { name: string; hubspotOwnerId: string; habiticaUserId: string; habiticaApiToken: string; };

function loadYaml<T=any>(rel: string): T {
  const p = path.resolve(process.cwd(), rel);
  return yaml.load(fs.readFileSync(p, "utf-8")) as T;
}

function loadMembers(): Member[] {
  const p = path.resolve(process.cwd(), "config/members.json");
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

// state.json で差分加点を実現
function loadState(): any {
  const p = path.resolve(process.cwd(), "data/state.json");
  if (!fs.existsSync(path.dirname(p))) fs.mkdirSync(path.dirname(p), { recursive: true });
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify({}), "utf-8");
  return { path: p, obj: JSON.parse(fs.readFileSync(p, "utf-8")) };
}
function saveState(pathStr: string, obj: any) { fs.writeFileSync(pathStr, JSON.stringify(obj, null, 2)); }

export async function run(dateISO?: string) {
  const schedule = loadYaml<any>("config/schedule.yml");
  const goals = loadYaml<any>("config/goals.yml");
  const tzName = schedule?.timezone || "Asia/Tokyo";
  const todayStr = (dateISO ? dayjs(dateISO) : dayjs()).tz(tzName).format("YYYY-MM-DD");

  const members = loadMembers();
  const { path: statePath, obj: stateObj } = loadState();
  stateObj[todayStr] = stateObj[todayStr] || {};

  console.log(`[orchestrator] date=${todayStr} tz=${tzName} members=${members.length}`);

  const stats = await fetchDailyCallStats(todayStr, members);

  for (const m of members) {
    const s = stats[m.hubspotOwnerId] || { calls: 0, minutes: 0 };
    const prev = stateObj[todayStr][m.hubspotOwnerId] || { calls: 0, minutes: 0 };

    const deltaCalls = Math.max(0, s.calls - prev.calls);
    const deltaMinutes = Math.max(0, s.minutes - prev.minutes);

    console.log(`[${m.name}] calls=${s.calls} (+${deltaCalls}) minutes=${s.minutes} (+${deltaMinutes})`);

    // Habiticaに差分だけ加点
    await addXpForKpi(
      { userId: m.habiticaUserId, apiToken: m.habiticaApiToken },
      deltaCalls,
      deltaMinutes,
      goals?.daily?.minutes?.block_minutes ?? 5
    );

    // state更新
    stateObj[todayStr][m.hubspotOwnerId] = s;
  }

  saveState(statePath, stateObj);
  console.log("[orchestrator] done");
}

if (require.main === module) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
