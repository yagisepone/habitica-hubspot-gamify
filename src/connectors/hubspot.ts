import axios from "axios";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import tz from "dayjs/plugin/timezone";
dayjs.extend(utc); dayjs.extend(tz);

const MOCK = String(process.env.MOCK_MODE || "").toLowerCase() === "true";
const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN || "";

type Member = { name: string; hubspotOwnerId: string; habiticaUserId: string; habiticaApiToken: string; };

function loadSchedule() {
  const p = path.resolve(process.cwd(), "config/schedule.yml");
  const obj = yaml.load(fs.readFileSync(p, "utf-8")) as any;
  return { timezone: obj?.timezone || "Asia/Tokyo" };
}

export async function fetchDailyCallStats(dateISO: string, members: Member[]) {
  // 戻り値: { [ownerId]: { calls: number, minutes: number } }
  const out: Record<string, { calls: number; minutes: number }> = {};

  if (MOCK || !HUBSPOT_TOKEN || HUBSPOT_TOKEN.includes("private_app_access_token_here")) {
    // ---- モック：メンバーごとに適当な数字を生成（安定化のためseedは日付+owner） ----
    const { timezone } = loadSchedule();
    const seedBase = dayjs.tz(dateISO, timezone).format("YYYYMMDD");
    members.forEach((m) => {
      const seed = [...(seedBase + m.hubspotOwnerId)].reduce((a, c) => a + c.charCodeAt(0), 0);
      const calls = 15 + (seed % 30);           // 15〜44件
      const minutes = 60 + (seed % 90);         // 60〜149分
      out[m.hubspotOwnerId] = { calls, minutes };
    });
    return out;
  }

  // ---- 本番：HubSpot Calls Search で集計（1日・各Owner） ----
  const headers = { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" };
  const { timezone } = loadSchedule();
  const start = dayjs.tz(dateISO, timezone).startOf("day").utc().toISOString();
  const end = dayjs.tz(dateISO, timezone).endOf("day").utc().toISOString();

  for (const m of members) {
    let after = undefined;
    let calls = 0;
    let minutes = 0;
    do {
      const body: any = {
        filterGroups: [{
          filters: [
            { propertyName: "hs_timestamp", operator: "GTE", value: start },
            { propertyName: "hs_timestamp", operator: "LTE", value: end },
            { propertyName: "hubspot_owner_id", operator: "EQ", value: m.hubspotOwnerId },
            { propertyName: "hs_call_status", operator: "EQ", value: "COMPLETED" }
          ]
        }],
        properties: ["hs_call_duration", "hs_call_status", "hubspot_owner_id", "hs_timestamp"],
        limit: 100,
        after
      };
      const res = await axios.post("https://api.hubapi.com/crm/v3/objects/calls/search", body, { headers });
      const results = res.data?.results || [];
      for (const r of results) {
        const durMs = Number(r.properties?.hs_call_duration ?? 0);
        calls += 1;
        minutes += Math.round(durMs / 1000 / 60); // 端数切捨て
      }
      after = res.data?.paging?.next?.after;
    } while (after);

    out[m.hubspotOwnerId] = { calls, minutes };
  }

  return out;
}
