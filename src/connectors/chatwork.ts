// src/connectors/chatwork.ts
import querystring from "querystring";

const CHATWORK_API_TOKEN = process.env.CHATWORK_API_TOKEN || "";
const CHATWORK_ROOM_ID   = process.env.CHATWORK_ROOM_ID || "";

export async function sendChatworkMessage(
  text: string,
  roomId: string = CHATWORK_ROOM_ID,
  token: string = CHATWORK_API_TOKEN
): Promise<{ success: boolean; status: number; json?: any; error?: string }> {
  if (!token) return { success: false, status: 0, error: "CHATWORK_API_TOKEN missing" };
  if (!roomId) return { success: false, status: 0, error: "CHATWORK_ROOM_ID missing" };

  const res = await fetch(`https://api.chatwork.com/v2/rooms/${roomId}/messages`, {
    method: "POST",
    headers: {
      "X-ChatWorkToken": token,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: querystring.stringify({ body: text }),
  } as any);
  const status = res.status;
  const json = await res.json().catch(() => undefined);
  return { success: status >= 200 && status < 300, status, json };
}

/* ===== 文面ビルダー ===== */

/** アポ通知（スクショと同じ：infoカードで3行、括弧は「」） */
export function cwApptText(actorName: string) {
  const n = actorName?.trim() || "担当者";
  const body = [
    "皆さんお疲れ様です！",
    `🎉 ${n} さんが「新規アポ」を獲得しました！💪🔥`,
    `ナイスコール！🙌 この調子でもう1件お願いします！💯`,
  ].join("\n");
  return `[info]\n${body}\n[/info]`;
}

/** 承認通知（従来どおり） */
export function cwApprovalText(actorName: string, maker?: string) {
  const n = actorName?.trim() || "担当者";
  const m = maker ? `（メーカー：${maker}）` : "";
  return [
    `✅ ${n} さんの『承認』が記録されました${m}！✨`,
    `素晴らしい！この勢いで積み上げていきましょう！💪`,
  ].join("\n");
}

/** 売上通知（従来どおり） */
export function cwSalesText(actorName: string, amount?: number, maker?: string) {
  const n = actorName?.trim() || "担当者";
  const am = amount ? `¥${Math.max(0, Math.floor(amount)).toLocaleString()}` : "売上";
  const m = maker ? `（メーカー：${maker}）` : "";
  return [
    `💰 ${n} さんの『売上 ${am}』を反映しました${m}！🎉`,
    `ナイス！引き続き頑張っていきましょう！📈`,
  ].join("\n");
}

/** CSVサマリー：プレーン表示（スクショのとおり info は使わない） */
export function cwCsvSummaryText(today: string, ok: number, sales: number, maker: number) {
  return `CSV取込（${today}）
承認 ${ok} / 売上 ${sales} / メーカー ${maker}`;
}

/** メーカー別成果：褒め言葉を一言追加（関数名・引数は既存互換） */
export function cwMakerAchievementText(
  actorName: string,
  maker?: string,
  approvedCount?: number,
  totalSalesYen?: number
) {
  const n = actorName?.trim() || "担当者";
  const lines = [`🏆 ${n} さんが『メーカー別 成果』を達成しました！🔥`];
  if (maker) lines.push(`・メーカー：${maker}`);
  if (typeof approvedCount === "number") lines.push(`・承認数：${approvedCount}件`);
  if (typeof totalSalesYen === "number")
    lines.push(`・売上合計：¥${Math.max(0, Math.floor(totalSalesYen)).toLocaleString()}`);
  lines.push("", "この勢いで次もいきましょう！💪");
  return lines.join("\n");
}
