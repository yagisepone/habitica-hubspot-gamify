import { createTodo, completeTask, HabiticaCred } from "../connectors/habitica";

/** n 回繰り返し用ユーティリティ */
function times(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

/**
 * 仕様の「XP量」を Habitica で近似再現。
 * - コール数: 1本 = 1ユニット
 * - 通話時間: 5分 = 1ユニット
 * - 新規アポ: 1ユニット（強調表示）
 * - 承認: 1ユニット
 * - 売上: 10万円 = 1ユニット
 *
 * いずれも ToDo を作成 → 即完了（XP/Gold付与）します。
 * 資格情報が無い場合は安全にスキップします。
 */
export async function awardForCalls(userName: string, count: number, cred?: HabiticaCred) {
  if (count <= 0) return;
  for (const _ of times(count)) {
    const t = await createTodo(`📞 コール実績（${userName}）`, `起点: Zoom`, undefined, cred);
    const id = (t as any)?.id;
    if (id) await completeTask(id, cred);
  }
}

export async function awardForDuration(userName: string, seconds: number, cred?: HabiticaCred) {
  const units = Math.floor((seconds || 0) / 300); // 5分=300秒
  if (units <= 0) return;
  for (const _ of times(units)) {
    const t = await createTodo(`⏱ 通話時間ユニット（${userName}）`, `5分ごとに1`, undefined, cred);
    const id = (t as any)?.id;
    if (id) await completeTask(id, cred);
  }
}

export async function awardForApo(userName: string, customer: string, whenJst: string, cred?: HabiticaCred) {
  const t = await createTodo(`🎯 新規アポ（${userName}）`, `顧客: ${customer}\n日時: ${whenJst}`, undefined, cred);
  const id = (t as any)?.id;
  if (id) await completeTask(id, cred);
}

export async function awardForApproval(userName: string, apoId: string, maker: string, cred?: HabiticaCred) {
  const t = await createTodo(`✅ 承認（${userName}）`, `apo_id: ${apoId}\nメーカー: ${maker}`, undefined, cred);
  const id = (t as any)?.id;
  if (id) await completeTask(id, cred);
}

export async function awardForRevenue(userName: string, jpy: number, cred?: HabiticaCred) {
  const units = Math.floor((jpy || 0) / 100_000); // 10万円/ユニット
  if (units <= 0) return;
  for (const _ of times(units)) {
    const t = await createTodo(
      `💰 売上10万円ユニット（${userName}）`,
      `累計: ${Number(jpy || 0).toLocaleString()} 円`,
      undefined,
      cred
    );
    const id = (t as any)?.id;
    if (id) await completeTask(id, cred);
  }
}

/* ========= 互換エクスポート（他ファイルからの参照対策） =========
   state_from_events.ts が calcDailyPoints(metrics, goals) の形で
   呼ぶため、第2引数 goals をオプションで受け取れるようにします。 */

/** metrics 形({calls, minutes, deals}) または配列(events)の両対応 */
export function calcDailyPoints(
  metricsOrEvents: any,
  _goals?: any // 互換のため受け取りだけして未使用
): number {
  // 配列なら単純に件数
  if (Array.isArray(metricsOrEvents)) {
    return metricsOrEvents.length;
  }
  // オブジェクト({ calls, minutes, deals })なら簡易スコア計算
  const calls = Number(metricsOrEvents?.calls || 0);
  const minutes = Number(metricsOrEvents?.minutes || 0);
  const deals = Number(metricsOrEvents?.deals || 0);
  // 5分=1pt 換算、コール=1pt、ディール=1pt（必要に応じ調整可）
  const durationPts = Math.floor(minutes / 5);
  return calls + durationPts + deals;
}

export function pickTitle(_pt?: number): string { return ""; }
export function checkBadges(_pt?: number): any[] { return []; }
export function judgeStreakAchieve(_days?: number): boolean { return false; }
export function streakBonus(_days?: number): number { return 0; }
export function buildAnnouncements(): any[] { return []; }
