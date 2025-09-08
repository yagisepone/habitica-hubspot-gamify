import fetch from "node-fetch";

export type HabiticaCred = { userId: string; apiToken: string };

function headers(cred?: HabiticaCred) {
  const user = cred?.userId ?? process.env.HABITICA_USER_ID;
  const key  = cred?.apiToken ?? process.env.HABITICA_API_TOKEN;
  if (!user || !key) {
    console.warn("[habitica] WARN: missing credentials (user or apiToken). skip.");
    return null; // 未設定は安全スキップ
  }
  const xcli = process.env.HABITICA_X_CLIENT || `sales-gamify`;
  return {
    "Content-Type": "application/json",
    "x-api-user": user,
    "x-api-key": key,
    "x-client": xcli,
  };
}

const BASE = process.env.HABITICA_BASE_URL || "https://habitica.com/api/v3";

export async function createTodo(
  title: string,
  note?: string,
  dateISO?: string,
  cred?: HabiticaCred
) {
  const h = headers(cred);
  if (!h) return { skipped: true, reason: "no_credentials" };
  const body: any = { text: title, type: "todo", notes: note || "" };
  if (dateISO) body.date = dateISO;

  console.log(`[habitica] createTodo title="${title}" user=${cred?.userId ?? "(common)"}`);
  const res = await fetch(`${BASE}/tasks/user`, {
    method: "POST",
    headers: h,
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Habitica createTodo ${res.status}: ${JSON.stringify(json)}`);
  return json.data; // { id, ... }
}

export async function completeTask(taskId: string, cred?: HabiticaCred) {
  const h = headers(cred);
  if (!h) return { skipped: true, reason: "no_credentials" };
  console.log(`[habitica] completeTask id=${taskId} user=${cred?.userId ?? "(common)"}`);
  const res = await fetch(`${BASE}/tasks/${taskId}/score/up`, {
    method: "POST",
    headers: h,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Habitica completeTask ${res.status}: ${JSON.stringify(json)}`);
  return json.data;
}

/** メーカー賞の演出（To-Do作成→即完了）。count 分だけ付与可 */
export async function addMakerAward(cred: HabiticaCred, count = 1) {
  for (let i = 0; i < count; i++) {
    const todo = await createTodo("🏆 ⚙メーカー賞", "本日の最多メーカー 受賞", undefined, cred);
    const id = (todo as any)?.id;
    if (id) await completeTask(id, cred);
  }
}

/** 互換：承認イベントをToDoとして記録（CSV取り込み向け） */
export async function addApproval(
  cred: HabiticaCred,
  amount: number,
  note?: string
) {
  const title = `✅ 承認 ${Number(amount || 0).toLocaleString()}円`;
  return createTodo(title, note ?? "CSV取り込み", undefined, cred);
}

/** 互換：売上イベントをToDoとして記録（CSV取り込み向け） */
export async function addSales(
  cred: HabiticaCred,
  amount: number,
  note?: string
) {
  const title = `💰 売上 ${Number(amount || 0).toLocaleString()}円`;
  return createTodo(title, note ?? "CSV取り込み", undefined, cred);
}
