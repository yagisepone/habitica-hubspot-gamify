import "dotenv/config";
import fs from "fs";
import path from "path";
import YAML from "js-yaml";

/**
 * 目的:
 *   - data/events/*.jsonl の "未処理イベント" を読み、該当ユーザーの Habitica にポイント付与
 *   - 同じイベントを二重付与しないよう data/processed.json で既処理IDを記録 (冪等)
 *
 * 前提:
 *   - config/users.yml に code: SELF の Habitica資格 (user/token/client) が入っている
 *   - Zoom: data/events/zoom_calls.jsonl に {payload.object.call_id, duration, owner_id}
 *   - HubSpot: data/events/hubspot_appointments.jsonl に {apo_id, owner_id}
 */

type HabiticaCred = { user: string; token: string; client: string };
type UserMap = Record<string, { name: string; habitica?: HabiticaCred }>;

const BASE = process.env.HABITICA_BASE_URL || "https://habitica.com/api/v3";
const DATA_DIR = path.join(process.cwd(), "data");
const EVENTS_DIR = path.join(DATA_DIR, "events");
const PROCESSED = path.join(DATA_DIR, "processed.json");

function loadUsers(): UserMap {
  const yml = fs.readFileSync(path.join("config", "users.yml"), "utf8");
  const arr = YAML.load(yml) as any[];
  const map: UserMap = {};
  for (const u of arr) {
    map[u.code] = {
      name: u.name || u.code,
      habitica: u.habitica && u.habitica.user ? {
        user: String(u.habitica.user).replace(/^\$\{(.+)\}$/, (_: any, k: string) => process.env[k] || ""),
        token: String(u.habitica.token).replace(/^\$\{(.+)\}$/, (_: any, k: string) => process.env[k] || ""),
        client: String(u.habitica.client).replace(/^\$\{(.+)\}$/, (_: any, k: string) => process.env[k] || ""),
      } : undefined
    };
  }
  return map;
}

function readJsonl(file: string): any[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

function loadProcessed(): Record<string, boolean> {
  if (!fs.existsSync(PROCESSED)) return {};
  try { return JSON.parse(fs.readFileSync(PROCESSED, "utf8") || "{}"); } catch { return {}; }
}
function saveProcessed(p: Record<string, boolean>) {
  fs.writeFileSync(PROCESSED, JSON.stringify(p, null, 2), "utf8");
}

/** ToDo を作って即完了（見える形で“達成”を積む） */
async function addTodoAndComplete(cred: HabiticaCred, text: string, priority = 1) {
  const headers = {
    "Content-Type": "application/json",
    "x-api-user": cred.user,
    "x-api-key": cred.token,
    "x-client": cred.client,
  } as any;

  const createRes = await fetch(`${BASE}/tasks/user`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text, type: "todo", priority }),
  });
  const createTxt = await createRes.text();
  if (!createRes.ok) throw new Error(`[habitica] create todo failed ${createRes.status} ${createTxt}`);
  const createJson = JSON.parse(createTxt);
  const id = createJson?.data?.id;
  if (!id) throw new Error(`[habitica] no id in create response`);

  const scoreRes = await fetch(`${BASE}/tasks/${id}/score/up`, { method: "POST", headers, body: "{}" });
  if (!scoreRes.ok) {
    const t = await scoreRes.text();
    throw new Error(`[habitica] score up failed ${scoreRes.status} ${t}`);
  }
}

/** 付与ロジック（仕様値に合わせて文言・重みを設定） */
async function awardCall(cred: HabiticaCred, who: string) {
  // コール 1本 = +1XP 相当 → 通知しやすいよう ToDoを1つ作って完了
  await addTodoAndComplete(cred, `[CALL] 架電 1本 (${who})`, 1);
}
async function awardDurationBonus(cred: HabiticaCred, who: string, durationSec: number) {
  // 5分(300s)ごと +2XP 相当 → 1単位ごとに ToDo(やや重め) を足す
  const units = Math.floor(durationSec / 300);
  for (let i = 0; i < units; i++) {
    await addTodoAndComplete(cred, `[CALL] 通話ボーナス +2 (5分達成) (${who})`, 1.5);
  }
}
async function awardAppointment(cred: HabiticaCred, who: string) {
  // 新規アポ +20XP 相当 → 優先度を高めに (2) で1発
  await addTodoAndComplete(cred, `[APO] 新規アポ獲得 +20 (${who})`, 2);
}

function assertCred(u: { name: string; habitica?: HabiticaCred }, code: string): HabiticaCred {
  if (!u?.habitica?.user || !u?.habitica?.token || !u?.habitica?.client) {
    throw new Error(`users.yml の ${code} に Habitica 資格がありません`);
  }
  return u.habitica!;
}

(async () => {
  const users = loadUsers();
  const processed = loadProcessed();

  const zoomEvents = readJsonl(path.join(EVENTS_DIR, "zoom_calls.jsonl"));
  const apoEvents  = readJsonl(path.join(EVENTS_DIR, "hubspot_appointments.jsonl"));

  let done = 0;

  // —— Zoom: 架電1本 + 通話ボーナス
  for (const ev of zoomEvents) {
    const callId: string = ev?.payload?.object?.call_id;
    const owner: string = ev?.payload?.owner_id || ev?.owner_id || "SELF";
    const duration: number = Number(ev?.payload?.object?.duration || 0);
    if (!callId) continue;

    const key = `zoom:${callId}`;
    if (processed[key]) continue;

    const u = users[owner] || users["SELF"];
    const cred = assertCred(u, owner);

    await awardCall(cred, u.name);
    if (duration > 0) await awardDurationBonus(cred, u.name, duration);

    processed[key] = true;
    done++;
  }

  // —— HubSpot: 新規アポ
  for (const ev of apoEvents) {
    const apoId: string = ev?.apo_id || ev?.payload?.object?.id || ev?.id;
    const owner: string = ev?.owner_id || ev?.payload?.owner_id || "SELF";
    if (!apoId) continue;

    const key = `apo:${apoId}`;
    if (processed[key]) continue;

    const u = users[owner] || users["SELF"];
    const cred = assertCred(u, owner);

    await awardAppointment(cred, u.name);

    processed[key] = true;
    done++;
  }

  saveProcessed(processed);
  console.log(`[award] processed=${done} (zoom+apo)`);
})().catch(e => { console.error(e); process.exit(1); });
