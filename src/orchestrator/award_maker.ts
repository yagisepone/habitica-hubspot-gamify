import { sendChatwork } from "../connectors/chatwork";
import { createTodo, completeTask } from "../connectors/habitica";
import { resolveHabiticaCred } from "../utils/users";
import members from "../../config/members.json";

/**
 * メーカー賞の授与演出
 * @param makerCounts 例: { "A社": 5, "B社": 3 }
 * @param holders     例: { "A社": ["123456","789012"] }
 */
export async function awardMakerPrize(
  makerCounts: Record<string, number>,
  holders: Record<string, string[]>
) {
  const best = Object.entries(makerCounts).sort((a, b) => b[1] - a[1])[0];
  if (!best) return;
  const [topMaker, topCount] = best;
  if (!topMaker || !topCount) return;

  const topOwnerIds = holders[topMaker] || [];
  const names = topOwnerIds.map(id => (members as any)[String(id)] || `Owner:${id}`).join(", ");

  // Chatwork告知（任意）
  try {
    await sendChatwork?.(
      `[info][title]🏆 ⚙メーカー賞 授与[/title]メーカー: ${topMaker}\n件数: ${topCount}\n受賞者: ${names}\n起点: 日次集計[/info]`
    );
  } catch {/* noop */}

  // Habiticaで受賞演出（To-Do作成→即完了）
  for (const ownerId of topOwnerIds) {
    const cred = resolveHabiticaCred(String(ownerId));
    const todo = await createTodo(`🏆 ⚙メーカー賞 (${topMaker})`, `本日の最多メーカー`, undefined, cred);
    if ((todo as any)?.id) await completeTask((todo as any).id, cred);
  }
}
