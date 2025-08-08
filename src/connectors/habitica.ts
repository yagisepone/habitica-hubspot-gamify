import axios from "axios";

const MOCK = String(process.env.MOCK_MODE || "").toLowerCase() === "true";

export type HabiticaCred = { userId: string; apiToken: string };

const HABITICA_API = "https://habitica.com/api/v3";

async function ensureHabitTask(cred: HabiticaCred, alias: string, text: string) {
  if (MOCK) return { id: `mock-${alias}` };
  const headers = { "x-api-user": cred.userId, "x-api-key": cred.apiToken, "Content-Type": "application/json" };

  // 既存タスク検索（alias）
  try {
    const list = await axios.get(`${HABITICA_API}/tasks/user`, { headers });
    const hit = (list.data?.data || []).find((t: any) => t.alias === alias);
    if (hit) return { id: hit.id };
  } catch { /* 無視して作成へ */ }

  // なければ作成（上昇のみのHabit）
  const payload = { type: "habit", text, alias, up: true, down: false, priority: 1 };
  const res = await axios.post(`${HABITICA_API}/tasks/user`, payload, { headers });
  return { id: res.data?.data?.id };
}

async function scoreUp(cred: HabiticaCred, taskId: string, times: number) {
  if (!times || times <= 0) return;
  if (MOCK) {
    console.log(`[MOCK] Habitica score up: ${taskId} x${times}`);
    return;
  }
  const headers = { "x-api-user": cred.userId, "x-api-key": cred.apiToken, "Content-Type": "application/json" };
  for (let i = 0; i < times; i++) {
    await axios.post(`${HABITICA_API}/tasks/${taskId}/score/up`, {}, { headers });
  }
}

export async function addXpForKpi(cred: HabiticaCred, calls: number, minutes: number, blockMinutes = 5) {
  const callsTask = await ensureHabitTask(cred, "calls-made", "Calls Made");
  const minsTask  = await ensureHabitTask(cred, "talk-minutes", `Talk Minutes (${blockMinutes}m block)`);
  const blocks = Math.floor(minutes / blockMinutes);

  await scoreUp(cred, callsTask.id, calls);
  await scoreUp(cred, minsTask.id, blocks);
}
