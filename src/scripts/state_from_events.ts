import "dotenv/config";
import fs from "fs";
import path from "path";
import dayjs from "dayjs";
import yaml from "js-yaml";
import { buildUserLookup } from "../utils/users";
import { calcDailyPoints } from "../engine/skillEngine";

type ByDateEntry = { calls: number; minutes: number; deals?: number; deltaPt: number };
type MemberState = { totalPt: number; streakDays: number; lastDate?: string; lastTitle?: string };
type StateShape = { byDate: Record<string, Record<string, ByDateEntry>>; byMember: Record<string, MemberState> };

function readJsonl(p: string) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf-8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function loadState(): StateShape {
  const p = path.resolve("data/state.json");
  if (!fs.existsSync(p)) return { byDate: {}, byMember: {} };
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return { byDate: {}, byMember: {} }; }
}
function saveState(s: StateShape) {
  const p = path.resolve("data/state.json");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(s, null, 2), "utf-8");
}

(async () => {
  const idx = process.argv.indexOf("--date");
  const date = idx >= 0 ? process.argv[idx + 1] : dayjs().format("YYYY-MM-DD");
  const from = dayjs(date).startOf("day");
  const to = dayjs(date).endOf("day");
  const inRange = (iso: any) => !!iso && dayjs(iso).valueOf() >= from.valueOf() && dayjs(iso).valueOf() <= to.valueOf();

  const zoom = readJsonl(path.resolve("data/events/zoom_calls.jsonl"))
    .filter((e: any) => e?.type === "outbound_call" && inRange(e.end_time || from.toISOString()));
  const approvals = readJsonl(path.resolve("data/events/approvals.jsonl"))
    .filter((e: any) => e?.type === "approval" && inRange(e.approved_at));

  const goals = yaml.load(fs.readFileSync(path.resolve("config/goals.yml"), "utf-8")) as any;
  const { byCanonical } = buildUserLookup();
  const statsByCanonical: Record<string, { calls: number; minutes: number; deals: number }> = {};

  for (const z of zoom) {
    const cid = String(z.canonical_user_id || "");
    if (!cid) continue;
    statsByCanonical[cid] ||= { calls: 0, minutes: 0, deals: 0 };
    statsByCanonical[cid].calls += 1;
    statsByCanonical[cid].minutes += Math.floor((z.duration_sec || 0) / 60);
  }
  for (const a of approvals) {
    const cid = String(a.canonical_user_id || "");
    if (!cid) continue;
    statsByCanonical[cid] ||= { calls: 0, minutes: 0, deals: 0 };
    statsByCanonical[cid].deals += 1;
  }

  const state = loadState();
  state.byDate[date] ||= {};

  for (const [cid, s] of Object.entries(statsByCanonical)) {
    const u = byCanonical[cid];
    if (!u?.hubspot_owner_id) continue;
    const ownerId = String(u.hubspot_owner_id);
    const deltaPt = calcDailyPoints({ calls: s.calls, minutes: s.minutes, deals: s.deals }, goals);
    state.byDate[date][ownerId] = { calls: s.calls, minutes: s.minutes, deals: s.deals, deltaPt };
    state.byMember[ownerId] ||= { totalPt: 0, streakDays: 0, lastTitle: "" };
    state.byMember[ownerId].totalPt += deltaPt;
  }

  saveState(state);
  console.log(`[state] updated for ${date}`);
})();
