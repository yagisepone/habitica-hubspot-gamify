import "dotenv/config";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import dayjs from "dayjs";
import { addMakerAward, HabiticaCred } from "../connectors/habitica";
import { buildUserLookup } from "../utils/users";
import { sendChatworkMessage } from "../connectors/chatwork";

// 目標など拡張用（未使用でもOK）
const goals = yaml.load(
  fs.readFileSync(path.resolve("config/goals.yml"), "utf-8")
) as any;

function readJsonl(filePath: string): any[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

export async function runDaily(targetDate?: string) {
  const tzDate = targetDate || dayjs().format("YYYY-MM-DD");
  const from = dayjs(tzDate).startOf("day");
  const to = dayjs(tzDate).endOf("day");
  const inRange = (iso: any) => {
    if (!iso) return false;
    const t = dayjs(iso).valueOf();
    return t >= from.valueOf() && t <= to.valueOf();
  };

  // 入力
  const appts = readJsonl(path.resolve("data/events/hubspot_appointments.jsonl"))
    .filter(e => e?.type === "new_appointment" && inRange(e.occurred_at));

  const approvals = readJsonl(path.resolve("data/events/approvals.jsonl"))
    .filter(e => e?.type === "approval" && inRange(e.approved_at));

  // 指標
  const apptCount = appts.length;
  const approvalCount = approvals.length;
  const rawRate = apptCount > 0 ? (approvalCount / apptCount) * 100 : 0;
  const approvalRate = Math.min(100, Math.round(rawRate * 10) / 10);

  // メーカー集計
  const makerCount: Record<string, number> = {};
  for (const a of approvals) {
    const key = String(a.maker || "不明");
    makerCount[key] = (makerCount[key] || 0) + 1;
  }
  const makers = Object.entries(makerCount).sort((a, b) => b[1] - a[1]);
  const topCount = makers[0]?.[1] ?? 0;
  const topMakers = makers.filter(([_, c]) => c === topCount).map(([m]) => m);

  // 受賞者（メーカー賞）抽出：同一人物の重複受賞を避ける
  const { byCanonical } = buildUserLookup();
  const winnerMap = new Map<string, any>(); // canonical_user_id -> 代表イベント
  for (const a of approvals) {
    if (!topMakers.includes(String(a.maker || ""))) continue;
    const cid = String(a.canonical_user_id || "");
    if (!cid) continue;
    if (!winnerMap.has(cid)) winnerMap.set(cid, a);
  }
  const winners = [...winnerMap.values()];

  // Habitica授与（資格がある人のみ / 一人1回）
  for (const w of winners) {
    const u = byCanonical[w.canonical_user_id];
    if (!u) continue;
    if (u.habitica_user_id && u.habitica_api_token) {
      const cred: HabiticaCred = { userId: u.habitica_user_id, apiToken: u.habitica_api_token };
      try {
        await addMakerAward(cred, 1);
      } catch (err) {
        console.warn(`[daily] Habitica award failed for ${u.display_name || u.name}: ${(err as Error).message}`);
      }
    } else {
      console.warn(`[daily] Habitica cred missing for ${u?.display_name ?? w.canonical_user_id} (skip maker award)`);
    }
  }

  // Chatwork通知（失敗しても継続）
  const makersText = makers.map(([m, c]) => `${m}:${c}件`).join(" / ") || "承認なし";
  try {
    await sendChatworkMessage(
      `🏆 ${tzDate} のメーカー賞：${topMakers.join("・") || "該当なし"} / 承認率 ${approvalRate}%（承認 ${approvalCount} / アポ ${apptCount}）\n内訳: ${makersText}`
    );
  } catch (err) {
    console.warn(`[daily] Chatwork send failed: ${(err as Error).message}`);
  }

  // Markdown出力
  const winnerLines =
    winners.length > 0
      ? winners.map((w) => `- ${w.display_name}（${w.maker}） ¥${(w.amount_jpy || 0).toLocaleString()}`)
      : ["- 該当者なし"];

  const report = [
    `# 日報 ${tzDate}`,
    ``,
    `- 承認率: **${approvalRate}%** （承認 ${approvalCount} / アポ ${apptCount}）`,
    `- メーカー内訳: ${makersText}`,
    `- メーカー賞: ${topMakers.join("・") || "該当なし"}`,
    ``,
    `## 承認者`,
    ...winnerLines,
  ].join("\n");

  const out = path.resolve("reports", `${tzDate}.md`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, report, "utf-8");

  console.log(
    `[daily] ${tzDate} done. approvalRate=${approvalRate}% top=${topMakers.join(",") || "-"} winners=${winners.length} report=${out}`
  );
}

if (require.main === module) {
  const idx = process.argv.indexOf("--date");
  const date = idx >= 0 ? process.argv[idx + 1] : undefined;
  runDaily(date).catch((err) => { console.error(err); process.exit(1); });
}
