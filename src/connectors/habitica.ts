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
  } as any);
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
  } as any);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Habitica completeTask ${res.status}: ${JSON.stringify(json)}`);
  return json.data;
}

/** 任意の“バッジ”（実態は記念ToDo）を演出付与 */
export async function addBadge(cred: HabiticaCred, label: string, note?: string) {
  const todo = await createTodo(`🏅 ${label}`, note ?? "badge", undefined, cred);
  const id = (todo as any)?.id;
  if (id) await completeTask(id, cred);
}

/** メーカー賞の演出（To-Do作成→即完了）。count 分だけ付与可 */
export async function addMakerAward(cred: HabiticaCred, count = 1) {
  for (let i = 0; i < count; i++) {
    const todo = await createTodo("🏆 ⚙メーカー賞", "本日の最多メーカー 受賞", undefined, cred);
    const id = (todo as any)?.id;
    if (id) await completeTask(id, cred);
  }
  // 記念バッジも追加（重複OK）
  await addBadge(cred, "⚙ メーカー賞", "top maker of the day");
}

/** 新規アポの“付与相当”演出（XP量はタイトル/notesで明示） */
export async function addAppointment(
  cred: HabiticaCred,
  xp: number,
  badgeLabel?: string
) {
  const title = `🟩 新規アポ +${xp}XP`;
  const notes = `rule=appointment+${xp}`;
  const todo = await createTodo(title, notes, undefined, cred);
  const id = (todo as any)?.id;
  if (id) await completeTask(id, cred);
  if (badgeLabel) await addBadge(cred, badgeLabel, "appointment achieved");
}

/** 互換：承認イベント（CSV取り込み向け） */
export async function addApproval(
  cred: HabiticaCred,
  amount: number,
  note?: string
) {
  const title = `✅ 承認 +30XP`;
  const notes = `rule=approval+30\n${note ?? "CSV"}`;
  const todo = await createTodo(title, notes, undefined, cred);
  const id = (todo as any)?.id;
  if (id) await completeTask(id, cred);
}

/** 互換：売上イベント（CSV取り込み向け） */
export async function addSales(
  cred: HabiticaCred,
  amount: number,
  note?: string
) {
  const title = `💰 売上 +50XP（¥${Number(amount || 0).toLocaleString()}）`;
  const notes = `rule=sales+50\n${note ?? "CSV"}`;
  const todo = await createTodo(title, notes, undefined, cred);
  const id = (todo as any)?.id;
  if (id) await completeTask(id, cred);
}
