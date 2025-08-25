import "dotenv/config";
import axios from "axios";

export type HabiticaCred = { userId: string; apiToken: string };

const HABITICA_API = process.env.HABITICA_API_BASE || "https://habitica.com/api/v3";
const X_CLIENT = process.env.HABITICA_X_CLIENT || "habitica-hubspot-gamify/1.0 (local-test)";
const MOCK = String(process.env.MOCK_MODE || "").toLowerCase() === "true";

const http = axios.create({
  baseURL: HABITICA_API,
  timeout: 5000,
  headers: { "x-client": X_CLIENT },
});

function headers(cred: HabiticaCred) {
  return {
    "x-api-user": cred.userId,
    "x-api-key": cred.apiToken,
    "Content-Type": "application/json",
    "x-client": X_CLIENT,
  };
}

async function ensureHabitTask(cred: HabiticaCred, alias: string, text: string) {
  if (MOCK) return { id: `mock-${alias}` };
  try {
    const list = await http.get("/tasks/user", { headers: headers(cred) });
    const hit = (list.data?.data || []).find((t: any) => t.alias === alias);
    if (hit) return { id: hit.id };
  } catch (e: any) {
    // 続行して作成を試みる
    console.warn("[Habitica] list tasks failed (continue):", e?.response?.status || e?.message);
  }
  const payload = { type: "habit", text, alias, up: true, down: false, priority: 1 };
  const res = await http.post("/tasks/user", payload, { headers: headers(cred) });
  return { id: res.data?.data?.id };
}

async function scoreUp(cred: HabiticaCred, taskId: string, times: number) {
  if (!times || times <= 0) return;
  if (MOCK) {
    console.log(`[MOCK] Habitica score up: ${taskId} x${times}`);
    return;
  }
  for (let i = 0; i < times; i++) {
    try {
      await http.post(`/tasks/${taskId}/score/up`, {}, { headers: headers(cred) });
    } catch (e: any) {
      console.error("[Habitica] score up failed:", e?.response?.status, e?.response?.data || e?.message);
      break; // 連続失敗を防ぐ
    }
  }
}

async function addEvent(cred: HabiticaCred, alias: string, text: string, count: number) {
  if (!count || count <= 0) return;
  const task = await ensureHabitTask(cred, alias, text);
  await scoreUp(cred, task.id, count);
}

export async function addXpForKpi(cred: HabiticaCred, calls: number, minutes: number, blockMinutes = 5) {
  const callsTask = await ensureHabitTask(cred, "calls-made", "Calls Made");
  const minsTask  = await ensureHabitTask(cred, "talk-minutes", `Talk Minutes (${blockMinutes}m block)`);
  await scoreUp(cred, callsTask.id, Math.max(0, calls || 0));
  await scoreUp(cred, minsTask.id, Math.floor(Math.max(0, minutes || 0) / blockMinutes));
}

export async function addNewAppointment(cred: HabiticaCred, count = 1) { return addEvent(cred, "new-appointment", "New Appointment", count); }
export async function addApproval(cred: HabiticaCred, count = 1)       { return addEvent(cred, "approval", "Approval", count); }
export async function addSales(cred: HabiticaCred, amountJpy: number)  {
  const times = Math.floor(Math.max(0, amountJpy || 0) / 100000);
  return addEvent(cred, "sales", "Sales (¥100k)", times);
}
export async function addDailyTask(cred: HabiticaCred, count = 1)      { return addEvent(cred, "daily-task", "Daily Task", count); }
export async function addMakerAward(cred: HabiticaCred, count = 1)     { return addEvent(cred, "maker-award", "Maker Award", count); }
