import fetch from "node-fetch";
import { log, normSpace } from "../lib/utils.js";
import { HAB_MAP, NAME2MAIL } from "../lib/maps.js";
import type { Badge } from "../types/ops.js";

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

function findCredential(identifier: string) {
  const raw = String(identifier || "").trim();
  if (!raw) return null;
  const email = raw.includes("@") ? raw.toLowerCase() : undefined;
  if (email && HAB_MAP[email]) return HAB_MAP[email];

  const byName = NAME2MAIL[normSpace(raw)];
  if (byName && HAB_MAP[byName]) return HAB_MAP[byName];

  for (const cred of Object.values(HAB_MAP)) {
    if (cred.userId === raw) return cred;
  }
  return null;
}

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

/** “バッジ”（実態は記念ToDo）を演出付与 */
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
  // 仕様：承認は固定 +30XP
  const xp = 30;
  const title = `✅ 承認 +${xp}XP`;
  const notes = `rule=approval+${xp}\n${note ?? "CSV"}`;
  const todo = await createTodo(title, notes, undefined, cred);
  const id = (todo as any)?.id;
  if (id) await completeTask(id, cred);

  //承認バッジ
  const label = process.env.APPROVAL_BADGE_LABEL || "🎖 承認";
  await addBadge(cred, label, "approval achieved");
}

/** 互換：売上イベント（CSV取り込み向け）
 *  仕様：10万円(既定)ごとに +50XP(既定)
 *   - SALES_XP_STEP_YEN：1ステップの金額（既定 100000）
 *   - SALES_XP_PER_STEP：ステップごとのXP（既定 50）
 */
export async function addSales(
  cred: HabiticaCred,
  amount: number,
  note?: string
) {
  const stepYen   = Number(process.env.SALES_XP_STEP_YEN || 100000); // 10万円
  const xpPerStep = Number(process.env.SALES_XP_PER_STEP || 50);     // 50XP/10万円
  const amt       = Math.max(0, Number(amount || 0));
  const steps     = Math.floor(amt / stepYen);
  const xp        = steps * xpPerStep;

  // 0円〜未満はXP付与しない（ToDoも作らない）
  if (xp <= 0) {
    console.log(`[habitica] addSales: amount=${amt} < step(${stepYen}); XP=0 → skip award`);
    return { skipped: true, reason: "below_step" };
  }

  const title = `💰 売上 +${xp}XP（¥${amt.toLocaleString()}）`;
  const notes = `rule=sales+${xp} (${xpPerStep}xp/${stepYen}yen)\n${note ?? "CSV"}`;
  const todo = await createTodo(title, notes, undefined, cred);
  const id = (todo as any)?.id;
  if (id) await completeTask(id, cred);
}

/* ===== Custom adjustments / party helpers ===== */

const partyCache = new Map<string, { partyId: string }>();

export async function adjustUserStats(
  tenantId: string,
  userId: string,
  deltaXp: number,
  deltaLvl?: number
): Promise<{ ok: true }> {
  const cred = findCredential(userId);
  if (!cred) {
    log(`[habitica] adjustUserStats skip(no-cred) tenant=${tenantId} user=${userId} xp=${deltaXp} lvl=${deltaLvl ?? 0}`);
    return { ok: true };
  }
  const dx = Number.isFinite(deltaXp) ? Number(deltaXp) : 0;
  const dl = Number.isFinite(deltaLvl ?? NaN) ? Number(deltaLvl) : 0;
  log(`[habitica] adjustUserStats tenant=${tenantId} user=${cred.userId} xp=${dx} lvl=${dl}`);
  // TODO: integrate with Habitica API to adjust stats directly.
  return { ok: true };
}

export async function ensurePartyForDomain(
  tenantId: string,
  domain: string
): Promise<{ partyId: string }> {
  const key = `${tenantId}:${domain.toLowerCase()}`;
  if (!partyCache.has(key)) {
    const partyId = `${tenantId}-${domain}`.replace(/[^a-zA-Z0-9_.@\-]/g, "-");
    partyCache.set(key, { partyId });
    log(`[habitica] ensurePartyForDomain create tenant=${tenantId} domain=${domain} party=${partyId}`);
  }
  return partyCache.get(key)!;
}

export async function joinParty(userId: string, partyId: string): Promise<void> {
  const cred = findCredential(userId);
  if (!cred) {
    log(`[habitica] joinParty skip(no-cred) user=${userId} party=${partyId}`);
    return;
  }
  log(`[habitica] joinParty user=${cred.userId} party=${partyId}`);
}

export async function awardBadgeItem(userId: string, badge: Badge): Promise<void> {
  const cred = findCredential(userId);
  if (!cred) {
    log(`[habitica] awardBadge skip(no-cred) user=${userId} badge=${badge.id}`);
    return;
  }
  log(`[habitica] awardBadge tenant-user=${userId} badge=${badge.title}`);
}
